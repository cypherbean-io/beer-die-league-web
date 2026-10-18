import type { MeResponse } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { type AuthEnv, requireSession } from '../auth/middleware.ts';
import { listMyMemberships } from '../domain/membership.ts';

export function meRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>().get('/me', requireSession(deps), async (c) => {
    const { userId, email } = c.get('auth')!;
    const memberships = await listMyMemberships(deps.db, userId);
    return c.json({ user: { id: userId, email }, memberships } satisfies MeResponse);
  });
}
