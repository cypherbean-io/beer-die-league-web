import { RequestCodeBody, VerifyCodeBody, type VerifyCodeResponse } from '@beer-die/core';
import { isIP } from 'node:net';
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
import { rateLimitAddress } from '../auth/rateLimit.ts';
import { revokeSession } from '../auth/sessions.ts';
import { readJson } from '../http.ts';

// The socket peer, or behind a trusted proxy the address it appended to X-Forwarded-For,
// as the per-address limits count it. Only the last entry is the proxy's; any before it
// came from the client.
function clientIp(c: Context, trustProxy: boolean): string {
  const forwarded = trustProxy
    ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
    : undefined;
  const address = forwarded && isIP(forwarded) ? forwarded : getConnInfo(c).remote.address;
  return address ? rateLimitAddress(address) : 'unknown';
}

export function authRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>()
    .post('/auth/code', async (c) => {
      const { email } = await readJson(c, RequestCodeBody);
      await requestCode(deps, { email, ip: clientIp(c, deps.config.trustProxy) });
      // Always 202 with an empty body, whether or not the email has an account.
      return c.body(null, 202);
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
      const auth = c.get('auth')!;
      await revokeSession(deps.db, auth.sessionId);
      if (auth.client === 'web') clearSessionCookie(c);
      return c.body(null, 204);
    });
}
