import {
  EmptyBody,
  RequestCodeBody,
  type RequestCodeResponse,
  VerifyCodeBody,
  type VerifyCodeResponse,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import {
  type AuthEnv,
  clearSessionCookie,
  requireSession,
  setSessionCookie,
} from '../auth/middleware.ts';
import { clientIp } from '../auth/clientIp.ts';
import { requestCode, verifyCode } from '../auth/otp.ts';
import { revokeAllSessions, revokeSession } from '../auth/sessions.ts';
import { readJson } from '../http.ts';

export function authRoutes(deps: AppDeps) {
  return (
    new Hono<AuthEnv>()
      .post('/auth/code', async (c) => {
        const { email } = await readJson(c, RequestCodeBody);
        const requestToken = await requestCode(deps, {
          email,
          ip: clientIp(c, deps.config.trustProxy),
        });
        // Always 202 with a fresh token, whether or not the email has an account.
        return c.json({ requestToken } satisfies RequestCodeResponse, 202);
      })
      .post('/auth/verify', async (c) => {
        const body = await readJson(c, VerifyCodeBody);
        const { user, token } = await verifyCode(deps, {
          ...body,
          ip: clientIp(c, deps.config.trustProxy),
        });
        if (body.client === 'native') return c.json({ user, token } satisfies VerifyCodeResponse);
        setSessionCookie(c, token);
        return c.json({ user } satisfies VerifyCodeResponse);
      })
      .post('/auth/logout', requireSession(deps), async (c) => {
        await readJson(c, EmptyBody);
        const auth = c.get('auth')!;
        await revokeSession(deps.db, auth.sessionId);
        if (auth.client === 'web') clearSessionCookie(c);
        return c.body(null, 204);
      })
      // Sign out everywhere: for a lost device, or a session someone else may hold.
      .post('/auth/logout-all', requireSession(deps), async (c) => {
        await readJson(c, EmptyBody);
        const auth = c.get('auth')!;
        await revokeAllSessions(deps.db, auth.userId);
        if (auth.client === 'web') clearSessionCookie(c);
        return c.body(null, 204);
      })
  );
}
