import type { ErrorBody, HealthResponse } from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.ts';

export function healthRoutes(db: Db) {
  return new Hono().get('/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      console.error(JSON.stringify({ level: 'error', msg: 'health: db check failed', code }));
      const body: ErrorBody = {
        error: { code: 'DB_UNAVAILABLE', message: 'Database unavailable' },
      };
      return c.json(body, 503);
    }
    return c.json({ status: 'ok' } satisfies HealthResponse);
  });
}
