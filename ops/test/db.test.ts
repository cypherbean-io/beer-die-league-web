import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../apps/api/src/db/migrate.ts';
import { compose, composeWith, STACK_DATABASE_URL } from './stack.ts';

describe('Postgres client auth under compose.yaml alone', () => {
  // A throwaway production-config project with its own volume, removed afterwards.
  const prod = {
    files: ['compose.yaml'],
    project: `beerdie-auth-${randomUUID().slice(0, 8)}`,
    env: { POSTGRES_PASSWORD: randomBytes(24).toString('base64url') },
  };

  // Over the Unix socket, which the committed pg_hba.conf trusts inside the container.
  const psqlLocal = (query: string) =>
    composeWith(prod, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'beerdie', '-tAc', query);

  // Over TCP, so the `host` rules apply. -w: fail rather than prompt for a password.
  const psqlTcp = (query: string, env: Record<string, string> = {}) =>
    composeWith(
      { ...prod, env: { ...prod.env, ...env } },
      'exec',
      '-T',
      ...Object.keys(env).flatMap((name) => ['-e', name]),
      'db',
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'beerdie',
      '-w',
      '-tAc',
      query,
    );

  beforeAll(async () => {
    await composeWith(prod, 'up', '-d', '--wait', 'db');
  });

  afterAll(async () => {
    await composeWith(prod, 'down', '-v');
  });

  it('reads client auth from the committed ops/pg_hba.conf, not from the data volume', async () => {
    expect((await psqlLocal('show hba_file')).trim()).toBe('/etc/postgresql/pg_hba.conf');
  });

  it("refuses a passwordless connection even when the volume's own pg_hba.conf trusts it", async () => {
    // What a volume first initialized under the dev or test overrides holds.
    await composeWith(
      prod,
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'echo "host all all all trust" >> "$PGDATA/pg_hba.conf"',
    );
    await psqlLocal('select pg_reload_conf()');

    await expect(psqlTcp('select 1')).rejects.toThrow(/no password supplied/);
  });

  it('accepts the superuser with its password', async () => {
    const out = await psqlTcp('select 1', { PGPASSWORD: prod.env.POSTGRES_PASSWORD });

    expect(out.trim()).toBe('1');
  });
});

// Blocks until a DO block (provisioning's) is waiting on a lock, bounded.
async function waitForBlockedProvisioning(sql: postgres.Sql): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await sql<[{ n: number }]>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%DO $$%'`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('provisioning never blocked');
}

describe('a failed role provisioning', () => {
  it('leaves the password out of the Postgres server log', async () => {
    const role = `beerdie_logtest_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = randomBytes(24).toString('base64url');
    const since = new Date().toISOString();
    const admin = postgres(STACK_DATABASE_URL, { max: 2, onnotice: () => {} });
    try {
      await admin.unsafe(`create role ${role} login`);
      let provisioning: Promise<unknown> = Promise.resolve();
      // An update to the role held open makes provisioning's ALTER ROLE wait, then fail with
      // "tuple concurrently updated" once it commits.
      await admin.begin(async (tx) => {
        await tx.unsafe(`alter role ${role} connection limit 5`);
        provisioning = provisionAppRole(STACK_DATABASE_URL, { role, password }).then(
          () => undefined,
          (err: unknown) => err,
        );
        await waitForBlockedProvisioning(admin);
      });

      expect(await provisioning).toMatchObject({ code: 'XX000' });
    } finally {
      // drop owned by: should provisioning have succeeded after all, its grants go too.
      await admin.unsafe(`drop owned by ${role}`);
      await admin.unsafe(`drop role ${role}`);
      await admin.end();
    }

    const log = await compose('logs', '--no-log-prefix', '--since', since, 'db');

    expect(log).not.toContain(password);
  });
});
