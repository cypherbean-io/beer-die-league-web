import type { MeResponse } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { type AuthEnv, requireSession } from '../auth/middleware.ts';

export function meRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>().get('/me', requireSession(deps), (c) => {
    const { userId, email } = c.get('auth')!;
    return c.json({ user: { id: userId, email } } satisfies MeResponse);
  });
}
