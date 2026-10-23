import { ErrorBody } from '@beer-die/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './support/server.ts';

let api: TestApi;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  api = await startApi(databaseUrl);
});

afterAll(async () => {
  await api.stop();
});

describe('unknown routes', () => {
  it('answers with 404 NOT_FOUND in the error body', async () => {
    const res = await fetch(`${api.baseUrl}/api/no-such-route`);

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(await res.json())).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
});

describe('request ids', () => {
  it('returns the id the access log records in an X-Request-Id header', async () => {
    const res = await fetch(`${api.baseUrl}/api/health`);

    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.logs).toContainEqual(
      expect.objectContaining({ msg: 'request', route: '/api/health', requestId }),
    );
  });
});
