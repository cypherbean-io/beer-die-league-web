import { LeagueResponse, MeResponse } from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase } from './support/db.ts';
import { cli, client, createLeague, signIn } from './support/league.ts';
import { startApi, type TestApi } from './support/server.ts';

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;
let call: ReturnType<typeof client>;

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  clock = new FixedClock('2026-10-18T12:00:00.000Z');
  api = await startApi(database.url, { clock });
  call = client(api.baseUrl);
  await api.db.execute(sql`truncate table invites, memberships, leagues, users cascade`);
});

afterEach(async () => {
  await api.stop();
});

const CREATE = [
  'create-league',
  '--name',
  'Basement League',
  '--commissioner-email',
  'Ana@Example.com',
  '--display-name',
  'Ana',
];

async function leagueCount(): Promise<number> {
  const [row] = await api.db.execute<{ n: number }>(sql`select count(*)::int as n from leagues`);
  return row!.n;
}

describe('create-league', () => {
  it('prints the new league and membership ids as JSON', async () => {
    const run = await cli(api.db, clock, CREATE);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout.join('\n'))).toEqual({
      leagueId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      membershipId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('makes the commissioner able to sign in and read the league', async () => {
    const { leagueId } = await createLeague(api.db, clock, {
      name: 'Basement League',
      email: 'ana@example.com',
      displayName: 'Ana',
    });
    const ana = await signIn(api.db, clock, 'ana@example.com');

    const res = await call('GET', `/api/leagues/${leagueId}`, { as: ana });

    expect(res.status).toBe(200);
    expect(LeagueResponse.parse(await res.json()).league.name).toBe('Basement League');
  });

  it('lowercases the commissioner email', async () => {
    await cli(api.db, clock, CREATE);

    const rows = await api.db.execute<{ email: string }>(sql`select email::text from users`);

    expect(rows.map((r) => r.email)).toEqual(['ana@example.com']);
  });

  it('reuses the account of a commissioner who already signed in', async () => {
    const ana = await signIn(api.db, clock, 'ana@example.com');

    await cli(api.db, clock, CREATE);

    const res = await call('GET', '/api/me', { as: ana });
    expect(MeResponse.parse(await res.json()).memberships).toMatchObject([
      { role: 'commissioner', status: 'approved' },
    ]);
  });

  it('never prints the email or display name', async () => {
    const argv = [...CREATE];
    argv[argv.indexOf('--display-name') + 1] = 'Anastasia';

    const run = await cli(api.db, clock, argv);

    const output = [...run.stdout, ...run.stderr].join('\n').toLowerCase();
    expect(run.code).toBe(0);
    expect(output).not.toContain('ana@example.com');
    expect(output).not.toContain('anastasia');
  });

  it.each([
    ['an invalid display name', ['--display-name', '<b>Ana</b>']],
    ['an invalid email', ['--commissioner-email', 'not-an-email']],
    ['an empty league name', ['--name', '   ']],
  ])('refuses %s with a usage error and creates nothing', async (_label, override) => {
    const argv = [...CREATE];
    argv[argv.indexOf(override[0]!) + 1] = override[1]!;

    const run = await cli(api.db, clock, argv);

    expect(run.code).toBe(2);
    expect(run.stderr.join('\n')).toMatch(/usage/i);
    expect(await leagueCount()).toBe(0);
  });

  it('refuses a missing flag with a usage error', async () => {
    const run = await cli(api.db, clock, CREATE.slice(0, 5));

    expect(run.code).toBe(2);
    expect(await leagueCount()).toBe(0);
  });

  it('refuses an unknown command with a usage error', async () => {
    const run = await cli(api.db, clock, ['drop-league']);

    expect(run.code).toBe(2);
    expect(run.stderr.join('\n')).toMatch(/usage/i);
  });

  it('does not echo stray values, such as an unquoted name or a misplaced email', async () => {
    const unquoted = await cli(api.db, clock, [...CREATE, 'Pemberton']);
    const misplaced = await cli(api.db, clock, ['zed@example.com', ...CREATE.slice(1)]);

    expect(unquoted.code).toBe(2);
    expect(misplaced.code).toBe(2);
    const stderr = [...unquoted.stderr, ...misplaced.stderr].join('\n');
    expect(stderr).not.toContain('Pemberton');
    expect(stderr).not.toContain('zed@example.com');
  });
});

describe('promote-commissioner', () => {
  async function approvedMember(leagueId: string, email: string, displayName: string) {
    const bo = await signIn(api.db, clock, email);
    await api.db.execute(
      sql`insert into memberships (league_id, user_id, display_name, name_key, role, status, created_at)
          values (${leagueId}, ${bo.userId}, ${displayName}, ${displayName.toLowerCase()}, 'member', 'approved', ${clock.now().toISOString()})`,
    );
    return bo;
  }

  it('promotes an approved member to commissioner', async () => {
    const { leagueId } = await createLeague(api.db, clock, {
      name: 'Basement League',
      email: 'ana@example.com',
      displayName: 'Ana',
    });
    const bo = await approvedMember(leagueId, 'bo@example.com', 'Bo');

    const run = await cli(api.db, clock, [
      'promote-commissioner',
      '--league-id',
      leagueId,
      '--email',
      'BO@example.com',
    ]);

    expect(run.code).toBe(0);
    const res = await call('GET', '/api/me', { as: bo });
    expect(MeResponse.parse(await res.json()).memberships).toMatchObject([
      { role: 'commissioner' },
    ]);
  });

  it('fails without changes when the email has no approved membership in the league', async () => {
    const { leagueId } = await createLeague(api.db, clock, {
      name: 'Basement League',
      email: 'ana@example.com',
      displayName: 'Ana',
    });

    const run = await cli(api.db, clock, [
      'promote-commissioner',
      '--league-id',
      leagueId,
      '--email',
      'nobody@example.com',
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr.join('\n')).not.toContain('nobody@example.com');
  });

  it('refuses a malformed league id with a usage error', async () => {
    const run = await cli(api.db, clock, [
      'promote-commissioner',
      '--league-id',
      'nope',
      '--email',
      'bo@example.com',
    ]);

    expect(run.code).toBe(2);
  });
});
