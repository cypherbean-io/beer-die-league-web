import { ErrorBody, HealthResponse } from '@beer-die/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startApi } from './support/server.ts';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function baseUrlFor(databaseUrl: string): Promise<string> {
  const api = await startApi(databaseUrl);
  stops.push(api.stop);
  return api.baseUrl;
}

describe('GET /api/health', () => {
  it('returns ok after a round trip to Postgres', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    const baseUrl = await baseUrlFor(databaseUrl);

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({ status: 'ok' });
  });

  it('returns 503 DB_UNAVAILABLE when Postgres refuses the connection', async () => {
    // Nothing listens on port 1 on loopback, so the connection is refused at once.
    const baseUrl = await baseUrlFor('postgres://postgres@127.0.0.1:1/beerdie');

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(503);
    expect(ErrorBody.parse(await res.json()).error.code).toBe('DB_UNAVAILABLE');
  });
});
