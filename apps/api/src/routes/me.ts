import {
  DeleteAccountBody,
  EmptyBody,
  type MeResponse,
  type RequestCodeResponse,
  UpdateMeBody,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { clientIp } from '../auth/clientIp.ts';
import { type AuthEnv, clearSessionCookie, requireSession } from '../auth/middleware.ts';
import { requestCode } from '../auth/otp.ts';
import { deleteAccount } from '../domain/departures.ts';
import { listMyMemberships, updateMe } from '../domain/membership.ts';
import { readJson } from '../http.ts';

export function meRoutes(deps: AppDeps) {
  return (
    new Hono<AuthEnv>()
      .get('/me', requireSession(deps), async (c) => {
        const { userId, email } = c.get('auth')!;
        const memberships = await listMyMemberships(deps.db, userId);
        return c.json({ user: { id: userId, email }, memberships } satisfies MeResponse);
      })
      .patch('/me', requireSession(deps), async (c) => {
        const body = await readJson(c, UpdateMeBody);
        const { userId, email } = c.get('auth')!;
        await updateMe(deps, userId, body);
        const memberships = await listMyMemberships(deps.db, userId);
        return c.json({ user: { id: userId, email }, memberships } satisfies MeResponse);
      })
      // Mails the caller the code that DELETE /me needs, to the address they signed in with.
      .post('/me/deletion-code', requireSession(deps), async (c) => {
        await readJson(c, EmptyBody);
        const requestToken = await requestCode(deps, {
          email: c.get('auth')!.email,
          ip: clientIp(c, deps.config.trustProxy),
          purpose: 'delete_account',
        });
        return c.json({ requestToken } satisfies RequestCodeResponse, 202);
      })
      // Deleting the account revokes every session, this one included.
      .delete('/me', requireSession(deps), async (c) => {
        const body = await readJson(c, DeleteAccountBody);
        const auth = c.get('auth')!;
        await deleteAccount(deps, auth, body);
        if (auth.client === 'web') clearSessionCookie(c);
        return c.body(null, 204);
      })
  );
}
