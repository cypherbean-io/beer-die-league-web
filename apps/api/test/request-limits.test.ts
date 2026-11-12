import { ErrorBody } from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createThrottle, DEFAULT_LIMITS, type ThrottleLimits } from '../src/auth/throttle.ts';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const NOW = '2026-11-12T12:00:00.000Z';

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi | undefined;
let clock: FixedClock;
let call: ReturnType<typeof client>;
// The throttle's own clock, which the tests move by hand.
let time: { ms: number };

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

afterEach(async () => {
  await api?.stop();
  api = undefined;
});

// The real app with the real throttle, on limits small enough to reach in a test.
async function serve(
  limits: Partial<ThrottleLimits> = {},
  opts: { trustProxy?: boolean } = {},
): Promise<TestApi> {
  clock = new FixedClock(NOW);
  time = { ms: 0 };
  api = await startApi(database.url, {
    clock,
    trustProxy: opts.trustProxy,
    throttle: createThrottle({ limits: { ...DEFAULT_LIMITS, ...limits }, nowMs: () => time.ms }),
  });
  call = client(api.baseUrl);
  await resetTables(api.db);
  return api;
}

function requestCode(n: number, forwardedFor?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_ORIGIN,
  };
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;
  return fetch(`${api!.baseUrl}/api/auth/code`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: `player${n}@example.com` }),
  });
}

async function rows(table: 'rate_limits' | 'auth_codes' | 'users'): Promise<number> {
  const [row] = await api!.db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return row!.n;
}

async function commissioner(): Promise<{ leagueId: string; caller: Caller }> {
  const email = 'ana@example.com';
  const { leagueId } = await createLeague(api!.db, clock, {
    name: 'Backyard',
    email,
    displayName: 'Ana',
  });
  return { leagueId, caller: await signIn(api!.db, clock, email) };
}

describe('sign-in requests from one address', () => {
  it('are refused past 30 a minute with 429 RATE_LIMITED', async () => {
    await serve();
    for (let i = 0; i < DEFAULT_LIMITS['auth-ip']; i++) {
      // Unknown routes count too: the limit covers everything under /api/auth.
      expect((await fetch(`${api!.baseUrl}/api/auth/nothing`)).status).toBe(404);
    }

    const res = await requestCode(0);

    expect(res.status).toBe(429);
    expect(ErrorBody.parse(await res.json()).error.code).toBe('RATE_LIMITED');
  });

  it('say when to try again in a Retry-After header', async () => {
    await serve({ 'auth-ip': 1 });
    await requestCode(0);
    time.ms = 20_000;

    const res = await requestCode(1);

    expect(res.headers.get('retry-after')).toBe('40');
  });

  it('write nothing to the database once refused', async () => {
    await serve({ 'auth-ip': 2 });
    await requestCode(0);
    await requestCode(1);
    const before = {
      limits: await rows('rate_limits'),
      codes: await rows('auth_codes'),
      users: await rows('users'),
    };

    const res = await requestCode(2);

    expect(res.status).toBe(429);
    expect({
      limits: await rows('rate_limits'),
      codes: await rows('auth_codes'),
      users: await rows('users'),
    }).toEqual(before);
  });

  it('are refused before a body over the size limit is read', async () => {
    await serve({ 'auth-ip': 1 });
    await requestCode(0);

    const res = await fetch(`${api!.baseUrl}/api/auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email: 'x'.repeat(20_000) }),
    });

    expect(res.status).toBe(429);
  });

  it('are allowed again a minute later', async () => {
    await serve({ 'auth-ip': 1 });
    await requestCode(0);
    time.ms = 60_000;

    const res = await requestCode(1);

    expect(res.status).toBe(202);
  });

  it('are logged with their status when refused', async () => {
    await serve({ 'auth-ip': 1 });
    await requestCode(0);

    await requestCode(1);

    expect(api!.logs.at(-1)).toMatchObject({ msg: 'request', status: 429, method: 'POST' });
  });

  it('are counted per forwarded client behind a trusted proxy', async () => {
    await serve({ 'auth-ip': 1 }, { trustProxy: true });
    await requestCode(0, '203.0.113.1');

    const other = await requestCode(1, '203.0.113.2');
    const same = await requestCode(2, '203.0.113.1');

    expect([other.status, same.status]).toEqual([202, 429]);
  });

  it('are counted per socket peer when no proxy is trusted, whatever X-Forwarded-For says', async () => {
    await serve({ 'auth-ip': 1 });
    await requestCode(0, '203.0.113.1');

    const res = await requestCode(1, '203.0.113.2');

    expect(res.status).toBe(429);
  });
});

describe('requests of any kind from one address', () => {
  it('are refused past the overall limit, whatever the route', async () => {
    await serve({ ip: 3 });
    for (let i = 0; i < 3; i++) await fetch(`${api!.baseUrl}/api/health`);

    const res = await fetch(`${api!.baseUrl}/api/me`);

    expect(res.status).toBe(429);
  });

  it('do not spend the stricter sign-in limit unless they are sign-in requests', async () => {
    await serve({ 'auth-ip': 1 });
    for (let i = 0; i < 5; i++) await fetch(`${api!.baseUrl}/api/health`);

    const res = await requestCode(0);

    expect(res.status).toBe(202);
  });
});

describe("a signed-in user's requests", () => {
  it('are refused past the per-user limit with 429 RATE_LIMITED', async () => {
    await serve({ user: 2 });
    const { caller } = await commissioner();
    await call('GET', '/api/me', { as: caller });
    await call('GET', '/api/me', { as: caller });

    const res = await call('GET', '/api/me', { as: caller });

    expect(res.status).toBe(429);
    expect(ErrorBody.parse(await res.json()).error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it("do not count against another user's limit", async () => {
    await serve({ user: 1 });
    const { caller } = await commissioner();
    const other = await signIn(api!.db, clock, 'bo@example.com');
    await call('GET', '/api/me', { as: caller });

    const res = await call('GET', '/api/me', { as: other });

    expect(res.status).toBe(200);
  });

  it('are counted per user across all of their sessions', async () => {
    await serve({ user: 1 });
    const { caller } = await commissioner();
    const secondDevice = await signIn(api!.db, clock, 'ana@example.com');
    await call('GET', '/api/me', { as: caller });

    const res = await call('GET', '/api/me', { as: secondDevice });

    expect(res.status).toBe(429);
  });

  it('do not count when the session token is not valid', async () => {
    await serve({ user: 1 });
    const { caller } = await commissioner();
    const stranger = { userId: caller.userId, token: 'A'.repeat(43) };
    await call('GET', '/api/me', { as: stranger });
    await call('GET', '/api/me', { as: stranger });

    const res = await call('GET', '/api/me', { as: caller });

    expect(res.status).toBe(200);
  });
});

describe("a member's stats reads", () => {
  it.each([
    ['player stats', '/stats/players?scope=combined'],
    ['partnership stats', '/stats/partnerships?scope=combined'],
  ])('are refused past the stats limit: %s', async (_name, path) => {
    await serve({ 'stats-user': 2 });
    const { leagueId, caller } = await commissioner();
    const url = `/api/leagues/${leagueId}${path}`;
    expect((await call('GET', url, { as: caller })).status).toBe(200);
    expect((await call('GET', url, { as: caller })).status).toBe(200);

    const res = await call('GET', url, { as: caller });

    expect(res.status).toBe(429);
  });

  it('share one limit with standings reads', async () => {
    await serve({ 'stats-user': 1 });
    const { leagueId, caller } = await commissioner();
    await call('GET', `/api/leagues/${leagueId}/stats/players?scope=combined`, { as: caller });

    // The season doesn't exist; the limit is spent before the lookup.
    const res = await call(
      'GET',
      `/api/leagues/${leagueId}/seasons/01920000-0000-7000-8000-000000000000/standings`,
      { as: caller },
    );

    expect(res.status).toBe(429);
  });

  it('leave the rest of the API usable once refused', async () => {
    await serve({ 'stats-user': 1 });
    const { leagueId, caller } = await commissioner();
    const url = `/api/leagues/${leagueId}/stats/players?scope=combined`;
    await call('GET', url, { as: caller });
    await call('GET', url, { as: caller });

    const res = await call('GET', `/api/leagues/${leagueId}/members`, { as: caller });

    expect(res.status).toBe(200);
  });

  it('are not counted for someone who is not a member of the league', async () => {
    await serve({ 'stats-user': 1 });
    const { leagueId, caller } = await commissioner();
    const outsider = await signIn(api!.db, clock, 'zed@example.com');
    const url = `/api/leagues/${leagueId}/stats/players?scope=combined`;

    const refused = await call('GET', url, { as: outsider });
    const res = await call('GET', url, { as: caller });

    expect([refused.status, res.status]).toEqual([404, 200]);
  });
});
