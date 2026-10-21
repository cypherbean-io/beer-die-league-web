import { DeleteAccountBody, type MeResponse } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { type AuthEnv, clearSessionCookie, requireSession } from '../auth/middleware.ts';
import { deleteAccount } from '../domain/departures.ts';
import { listMyMemberships } from '../domain/membership.ts';
import { readJson } from '../http.ts';

export function meRoutes(deps: AppDeps) {
  return (
    new Hono<AuthEnv>()
      .get('/me', requireSession(deps), async (c) => {
        const { userId, email } = c.get('auth')!;
        const memberships = await listMyMemberships(deps.db, userId);
        return c.json({ user: { id: userId, email }, memberships } satisfies MeResponse);
      })
      // Deleting the account revokes every session, this one included.
      .delete('/me', requireSession(deps), async (c) => {
        const { keepDisplayName } = await readJson(c, DeleteAccountBody);
        const auth = c.get('auth')!;
        await deleteAccount(deps, auth.userId, keepDisplayName);
        if (auth.client === 'web') clearSessionCookie(c);
        return c.body(null, 204);
      })
  );
}
