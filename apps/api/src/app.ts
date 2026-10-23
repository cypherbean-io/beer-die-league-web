import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { type AuthEnv, csrfGuard } from './auth/middleware.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db/client.ts';
import { ApiError, errorBody } from './http.ts';
import { type Log, safeErrorFields } from './log.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { inviteRoutes } from './routes/invites.ts';
import { leagueRoutes } from './routes/leagues.ts';
import { meRoutes } from './routes/me.ts';

export type AppDeps = {
  db: Db;
  clock: Clock;
  config: { authSecret: string; appOrigin: string; trustProxy: boolean };
  log: Log;
};

const MAX_BODY_BYTES = 16 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono<AuthEnv>().basePath('/api');

  // Access log: the route template, never the raw path (invite tokens appear in paths). The
  // request id goes on every line logged for the request and back to the client in
  // X-Request-Id, so a report of a failed request leads to its log lines.
  app.use('*', async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
    deps.log({
      level: 'info',
      msg: 'request',
      requestId,
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      userId: c.get('auth')?.userId,
    });
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('PAYLOAD_TOO_LARGE', 'Request body over 16 KB'), 413),
    }),
  );
  app.use('*', csrfGuard(deps.config.appOrigin));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), err.status);
    }
    // Hono's default handler would print the error, and pg messages can quote user data.
    deps.log({
      level: 'error',
      msg: 'unhandled error',
      requestId: c.get('requestId'),
      route: routePath(c, -1),
      ...safeErrorFields(err),
    });
    return c.json(errorBody('INTERNAL', 'Internal server error'), 500);
  });
  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Not found'), 404));

  return app
    .route('/', healthRoutes(deps))
    .route('/', authRoutes(deps))
    .route('/', meRoutes(deps))
    .route('/', inviteRoutes(deps))
    .route('/leagues/:leagueId', leagueRoutes(deps));
}
