import type { AddressInfo } from 'node:net';
import { ErrorBody, HealthResponse } from '@beer-die/core';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createDb } from '../src/db/client.ts';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

// Serves the real app over HTTP on an ephemeral port, backed by the given database.
async function startApi(databaseUrl: string): Promise<string> {
  const { db, close } = createDb(databaseUrl);
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: createApp({ db }).fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve(s),
    );
  });
  stops.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await close();
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /api/health', () => {
  it('returns ok after a round trip to Postgres', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    const baseUrl = await startApi(databaseUrl);

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({ status: 'ok' });
  });

  it('returns 503 DB_UNAVAILABLE when Postgres refuses the connection', async () => {
    // Nothing listens on port 1 on loopback, so the connection is refused at once.
    const baseUrl = await startApi('postgres://postgres@127.0.0.1:1/beerdie');

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(503);
    expect(ErrorBody.parse(await res.json()).error.code).toBe('DB_UNAVAILABLE');
  });
});
