import { randomBytes, randomUUID } from 'node:crypto';
import { LeagueResponse } from '@beer-die/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { provisionAppRole, provisionBackupRole } from '../src/db/migrate.ts';
import { freshDatabase } from './support/db.ts';
import { client, createLeague, signIn } from './support/league.ts';
import { startApi } from './support/server.ts';

const INSUFFICIENT_PRIVILEGE = '42501';

let database: Awaited<ReturnType<typeof freshDatabase>>;
let role: string;
let backupRole: string;
let password: string;
let admin: postgres.Sql;
let asApp: postgres.Sql;
let asBackup: postgres.Sql;

function asRole(url: string, name: string): string {
  const u = new URL(url);
  u.username = name;
  u.password = password;
  return u.toString();
}

async function sqlState(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

// Roles are cluster-wide, so each run provisions its own and drops it afterwards.
beforeAll(async () => {
  database = await freshDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  role = `beerdie_app_${suffix}`;
  backupRole = `beerdie_backup_${suffix}`;
  password = randomBytes(24).toString('base64url');
  await provisionAppRole(database.url, { role, password });
  await provisionBackupRole(database.url, { role: backupRole, password });
  admin = postgres(database.url, { max: 1, onnotice: () => {} });
  asApp = postgres(asRole(database.url, role), { max: 1, onnotice: () => {} });
  asBackup = postgres(asRole(database.url, backupRole), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  // Unset if beforeAll failed partway; the roles it made must still be dropped.
  await asApp?.end();
  await asBackup?.end();
  await admin?.end();
  await database.drop();
  const cluster = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await cluster.unsafe(`drop role if exists ${role}`);
    await cluster.unsafe(`drop role if exists ${backupRole}`);
  } finally {
    await cluster.end();
  }
});

describe('the app role provisioned by migrate', () => {
  it('runs the API: bootstrap, sign-in, reads, and account deletion', async () => {
    const clock = new FixedClock('2026-10-21T12:00:00.000Z');
    const api = await startApi(asRole(database.url, role), { clock });
    try {
      const { leagueId } = await createLeague(api.db, clock, {
        name: 'Basement League',
        email: 'ana@example.com',
        displayName: 'Ana',
      });
      const ana = await signIn(api.db, clock, 'ana@example.com');
      const call = client(api.baseUrl);

      const league = await call('GET', `/api/leagues/${leagueId}`, { as: ana });
      const deleted = await call('DELETE', '/api/me', {
        as: ana,
        body: { keepDisplayName: false },
      });

      expect(league.status).toBe(200);
      expect(LeagueResponse.parse(await league.json()).league.name).toBe('Basement League');
      expect(deleted.status).toBe(204);
    } finally {
      await api.stop();
    }
  });

  it('is refused UPDATE on audit_events by privilege, not only by the trigger', async () => {
    expect(await sqlState(asApp`update audit_events set action = action`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('is refused DELETE on audit_events by privilege, not only by the trigger', async () => {
    expect(await sqlState(asApp`delete from audit_events`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is refused TRUNCATE on audit_events', async () => {
    expect(await sqlState(asApp`truncate audit_events`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot disable the append-only triggers', async () => {
    expect(await sqlState(asApp`alter table audit_events disable trigger all`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('is neither a superuser nor the owner of any table', async () => {
    const [row] = await admin<[{ super: boolean; owned: number }]>`
      select (select rolsuper from pg_roles where rolname = ${role}) as super,
             (select count(*)::int from pg_tables where tableowner = ${role}) as owned`;

    expect(row).toEqual({ super: false, owned: 0 });
  });

  it('gains access to tables a later migration adds when migrate runs again', async () => {
    await admin`create table later_migration (id int primary key)`;

    await provisionAppRole(database.url, { role, password });

    expect(await asApp`select id from later_migration`).toEqual([]);
  });

  it('refuses to provision a superuser as the app role', async () => {
    await expect(provisionAppRole(database.url, { role: 'postgres', password })).rejects.toThrow(
      /neither the migrating role nor a superuser/,
    );
  });

  it('refuses a password shorter than 16 characters', async () => {
    await expect(provisionAppRole(database.url, { role, password: 'short' })).rejects.toThrow(
      /at least 16 characters/,
    );
  });
});

describe('the backup role provisioned by migrate', () => {
  it('can read every table, including audit_events', async () => {
    expect(await asBackup`select count(*)::int as n from audit_events`).toEqual([{ n: 0 }]);
  });

  it('can read the migration journal, which pg_dump dumps too', async () => {
    const [row] = await asBackup<[{ n: number }]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`;

    expect(row!.n).toBeGreaterThan(0);
  });

  it("cannot read other roles' password verifiers", async () => {
    expect(await sqlState(asBackup`select rolpassword from pg_authid`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot write to any table', async () => {
    expect(await sqlState(asBackup`delete from rate_limits`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is not a superuser, so it cannot disable the append-only triggers', async () => {
    expect(await sqlState(asBackup`alter table audit_events disable trigger all`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('refuses to provision a superuser as the backup role', async () => {
    await expect(provisionBackupRole(database.url, { role: 'postgres', password })).rejects.toThrow(
      /neither the migrating role nor a superuser/,
    );
  });
});
