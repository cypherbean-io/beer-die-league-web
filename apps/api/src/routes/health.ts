import type { ErrorBody, HealthResponse } from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { AuthEnv } from '../auth/middleware.ts';
import { safeErrorFields } from '../log.ts';

export function healthRoutes(deps: Pick<AppDeps, 'db' | 'log'>) {
  return new Hono<AuthEnv>().get('/health', async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
    } catch (err) {
      deps.log({
        level: 'error',
        msg: 'health: db check failed',
        requestId: c.get('requestId'),
        ...safeErrorFields(err),
      });
      const body: ErrorBody = {
        error: { code: 'DB_UNAVAILABLE', message: 'Database unavailable' },
      };
      return c.json(body, 503);
    }
    return c.json({ status: 'ok' } satisfies HealthResponse);
  });
}
