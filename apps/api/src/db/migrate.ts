import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { safeErrorFields, stdoutLog as log } from '../log.ts';

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

// Applies every committed migration in src/db/migrations that the database hasn't seen.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const MIN_PASSWORD_LENGTH = 16;

type Login = { role: string; password: string };

// Thrown for a bad login before anything secret reaches Postgres; its message is fixed.
export class RoleError extends Error {}

// What each login may do: PL/pgSQL statements naming the role `r`.
const APP_GRANTS = `
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM %I', r);`;

// Not pg_read_all_data: that spans the cluster and reads pg_authid's password verifiers.
// drizzle holds the migration journal, which the dump needs too.
const BACKUP_GRANTS = `
  EXECUTE format('GRANT USAGE ON SCHEMA public, drizzle TO %I', r);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO %I', r);
  EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO %I', r);`;

// Creates or updates `login` as a password login that is neither a superuser nor the
// migrating role, then applies `grants`, all in one transaction. The role and password come
// in through set_config, so neither is spliced into SQL text; format() quotes them for the
// statements that can't take parameters.
async function provisionLogin(databaseUrl: string, login: Login, grants: string): Promise<void> {
  if (!ROLE_PATTERN.test(login.role)) {
    throw new RoleError('The role name must be a lowercase SQL identifier');
  }
  if (login.password.length < MIN_PASSWORD_LENGTH) {
    throw new RoleError(`The role password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      // Postgres logs a failed ALTER ROLE with its text, password literal included, and under
      // log_statement the password parameter too. Only a superuser, as migrate is, may set this.
      await tx.unsafe('set local log_min_messages = panic');
      const [row] = await tx<[{ self: boolean; super: boolean }]>`
        select current_user = ${login.role} as self,
               coalesce((select rolsuper from pg_roles where rolname = ${login.role}), false) as super`;
      if (row!.self || row!.super) {
        throw new RoleError('The role must be neither the migrating role nor a superuser');
      }
      await tx`select set_config('beerdie.role', ${login.role}, true),
                      set_config('beerdie.password', ${login.password}, true)`;
      await tx.unsafe(`
DO $$
DECLARE
  r text := current_setting('beerdie.role');
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I', r);
  END IF;
  EXECUTE format(
    'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
    r, current_setting('beerdie.password'));
${grants}
END $$`);
    });
  } finally {
    await client.end();
  }
}

// The login the API and worker connect as in production: neither owner nor superuser, so it
// can't drop audit_events' append-only triggers, and with no UPDATE or DELETE on audit_events
// at all (SPEC §4). Grants cover the tables that exist now, so migrate runs this after every
// migration.
export function provisionAppRole(databaseUrl: string, app: Login): Promise<void> {
  return provisionLogin(databaseUrl, app, APP_GRANTS);
}

// The login the backup service dumps with: it can read the league's tables and write none.
export function provisionBackupRole(databaseUrl: string, backup: Login): Promise<void> {
  return provisionLogin(databaseUrl, backup, BACKUP_GRANTS);
}

// Each variable is the URL a service connects with; only its user and password are used.
const LOGINS = [
  { variable: 'APP_DATABASE_URL', provision: provisionAppRole },
  { variable: 'BACKUP_DATABASE_URL', provision: provisionBackupRole },
] as const;

function loginFrom(variable: string, value: string): Login {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoleError(`${variable} is not a valid URL`);
  }
  return { role: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await runMigrations(databaseUrl);
  log({ level: 'info', msg: 'migrations applied' });

  // Empty in dev, where everything connects as the owner.
  for (const { variable, provision } of LOGINS) {
    const value = process.env[variable];
    if (!value) continue;
    try {
      const login = loginFrom(variable, value);
      await provision(databaseUrl, login);
      log({ level: 'info', msg: 'role provisioned', role: login.role });
    } catch (err) {
      // A Postgres error can carry the bound parameters, which include the password.
      const detail = err instanceof RoleError ? { reason: err.message } : safeErrorFields(err);
      log({ level: 'error', msg: 'role provisioning failed', variable, ...detail });
      process.exitCode = 1;
    }
  }
}
