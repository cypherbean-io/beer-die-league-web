import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Clock } from '../clock.ts';
import type { Db } from '../db/client.ts';
import { type Actor, resolveMembership } from '../domain/membership.ts';
import { ApiError, idParam } from '../http.ts';
import { resolveSession, type SessionAuth, TOKEN_PATTERN } from './sessions.ts';

// `requestId` is set by the access log before anything else runs.
export type AuthEnv = { Variables: { requestId?: string; auth?: SessionAuth } };
export type LeagueEnv = {
  Variables: { requestId?: string; auth?: SessionAuth; membership?: Actor };
};

export const SESSION_COOKIE = 'session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The server enforces the 30-day idle expiry. The cookie lives as long as browsers allow,
// so an active user isn't signed out 30 days after signing in.
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/api',
} as const;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_S });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
}

// CSRF defence for writes. Every write must be JSON, which an HTML form can't send. A write
// that carries the session cookie (and no bearer token) must also come from APP_ORIGIN.
export function csrfGuard(appOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/json') {
        throw new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Expected Content-Type: application/json',
        );
      }
      const cookieAuth =
        c.req.header('authorization') === undefined && getCookie(c, SESSION_COOKIE) !== undefined;
      if (cookieAuth && c.req.header('origin') !== appOrigin) {
        throw new ApiError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin request refused');
      }
    }
    await next();
  };
}

// Resolves the caller's session from `Authorization: Bearer` (native) or the cookie (web).
export function requireSession(deps: { db: Db; clock: Clock }): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const unauthenticated = new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const header = c.req.header('authorization');
    const bearer = header === undefined ? undefined : /^Bearer (\S+)$/.exec(header)?.[1];
    const token = header === undefined ? getCookie(c, SESSION_COOKIE) : bearer;
    if (!token || !TOKEN_PATTERN.test(token)) throw unauthenticated;

    const auth = await resolveSession(deps.db, {
      token,
      client: header === undefined ? 'web' : 'native',
      now: deps.clock.now(),
    });
    if (!auth) throw unauthenticated;
    c.set('auth', auth);
    await next();
  };
}

// Tenancy: resolves the caller's approved membership for `:leagueId`. Non-members, pending
// members, and unknown leagues all get the same 404, so a league's existence never leaks.
// Runs after requireSession. Role checks happen in the domain layer.
export function requireMembership(deps: { db: Db }): MiddlewareHandler<LeagueEnv> {
  return async (c, next) => {
    const leagueId = idParam(c, 'leagueId');
    const membership = await resolveMembership(deps.db, {
      userId: c.get('auth')!.userId,
      leagueId,
    });
    if (!membership) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    c.set('membership', membership);
    await next();
  };
}
