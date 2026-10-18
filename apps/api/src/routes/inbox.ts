import type { InboxResponse } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import { listInbox } from '../domain/games.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function inboxRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>().get('/inbox', async (c) => {
    const games = await listInbox(deps, c.get('membership')!);
    return c.json({ games } satisfies InboxResponse);
  });
}
