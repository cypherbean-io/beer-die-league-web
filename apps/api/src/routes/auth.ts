import { RequestCodeBody, VerifyCodeBody, type VerifyCodeResponse } from '@beer-die/core';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import {
  type AuthEnv,
  clearSessionCookie,
  requireSession,
  setSessionCookie,
} from '../auth/middleware.ts';
import { requestCode, verifyCode } from '../auth/otp.ts';
import { revokeSession } from '../auth/sessions.ts';
import { readJson } from '../http.ts';

// The socket peer. Behind Caddy (slice 8) this must come from the trusted proxy header.
function clientIp(c: Context): string {
  return getConnInfo(c).remote.address ?? 'unknown';
}

export function authRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>()
    .post('/auth/code', async (c) => {
      const { email } = await readJson(c, RequestCodeBody);
      await requestCode(deps, { email, ip: clientIp(c) });
      // Always 202 with an empty body, whether or not the email has an account.
      return c.body(null, 202);
    })
    .post('/auth/verify', async (c) => {
      const body = await readJson(c, VerifyCodeBody);
      const { user, token } = await verifyCode(deps, { ...body, ip: clientIp(c) });
      if (body.client === 'native') return c.json({ user, token } satisfies VerifyCodeResponse);
      setSessionCookie(c, token);
      return c.json({ user } satisfies VerifyCodeResponse);
    })
    .post('/auth/logout', requireSession(deps), async (c) => {
      const auth = c.get('auth')!;
      await revokeSession(deps.db, auth.sessionId);
      if (auth.client === 'web') clearSessionCookie(c);
      return c.body(null, 204);
    });
}
