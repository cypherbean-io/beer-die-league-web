import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const CODE_REQUESTS_PER_IP = 20;

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi | undefined;

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

async function serve(trustProxy: boolean): Promise<void> {
  api = await startApi(database.url, {
    clock: new FixedClock('2026-10-21T12:00:00.000Z'),
    trustProxy,
  });
  await resetTables(api.db);
}

function requestCode(email: string, forwardedFor?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_ORIGIN,
  };
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;
  return fetch(`${api!.baseUrl}/api/auth/code`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email }),
  });
}

// Spends one address's hourly budget, each request for a different email so only the
// per-IP limit is in play.
async function exhaustIpBudget(forwardedFor?: (i: number) => string | undefined): Promise<void> {
  for (let i = 0; i < CODE_REQUESTS_PER_IP; i++) {
    const res = await requestCode(`player${i}@example.com`, forwardedFor?.(i));
    expect(res.status).toBe(202);
  }
}

describe('client address behind a trusted proxy (TRUST_PROXY=true)', () => {
  it('counts code requests per forwarded client, not per proxy', async () => {
    await serve(true);
    await exhaustIpBudget(() => '203.0.113.1');

    const res = await requestCode('player20@example.com', '203.0.113.2');

    expect(res.status).toBe(202);
  });

  it('still refuses the 21st code request an hour from one forwarded client', async () => {
    await serve(true);
    await exhaustIpBudget(() => '203.0.113.1');

    const res = await requestCode('player20@example.com', '203.0.113.1');

    expect(res.status).toBe(429);
  });

  it('uses the address the proxy appended, not one the client put before it', async () => {
    await serve(true);
    await exhaustIpBudget(() => '203.0.113.1');

    const res = await requestCode('player20@example.com', '198.51.100.7, 203.0.113.1');

    expect(res.status).toBe(429);
  });

  it('falls back to the socket peer when the forwarded value is not an IP address', async () => {
    await serve(true);
    await exhaustIpBudget();

    const res = await requestCode('player20@example.com', 'not-an-address');

    expect(res.status).toBe(429);
  });
});

describe('client address without a trusted proxy', () => {
  it('ignores X-Forwarded-For, so a client cannot dodge the per-address limit', async () => {
    await serve(false);
    await exhaustIpBudget((i) => `203.0.113.${i + 1}`);

    const res = await requestCode('player20@example.com', '203.0.113.99');

    expect(res.status).toBe(429);
  });
});

describe('client address for per-address limits', () => {
  it('counts every IPv6 address in one /64 as one client', async () => {
    await serve(true);
    await exhaustIpBudget((i) => `2001:db8:1:2::${(i + 1).toString(16)}`);

    const res = await requestCode('player20@example.com', '2001:db8:1:2:ffff:ffff:ffff:ffff');

    expect(res.status).toBe(429);
  });

  it('counts any spelling of one /64 as the same client', async () => {
    await serve(true);
    await exhaustIpBudget(() => '2001:db8:1:2::1');

    const res = await requestCode('player20@example.com', '2001:0DB8:0001:0002:0:0:0:9');

    expect(res.status).toBe(429);
  });

  it('counts different IPv6 /64s as different clients', async () => {
    await serve(true);
    await exhaustIpBudget(() => '2001:db8:1:2::1');

    const res = await requestCode('player20@example.com', '2001:db8:1:3::1');

    expect(res.status).toBe(202);
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4 address', async () => {
    await serve(true);
    await exhaustIpBudget(() => '::ffff:203.0.113.1');

    const res = await requestCode('player20@example.com', '203.0.113.1');

    expect(res.status).toBe(429);
  });
});
