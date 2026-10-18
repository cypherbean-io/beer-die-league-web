import { type LeagueResponse, RulesBody, SettingsBody } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { type LeagueEnv, requireMembership, requireSession } from '../auth/middleware.ts';
import { getLeague, updateRules, updateSettings } from '../domain/leagues.ts';
import { readJson } from '../http.ts';
import { auditRoutes } from './audit.ts';
import { gameRoutes } from './games.ts';
import { leagueInviteRoutes } from './invites.ts';
import { memberRoutes } from './members.ts';

// Mounted at /leagues/:leagueId. Every route below resolves the caller's approved membership
// first; handlers read the league from it, never from the request.
export function leagueRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .use('*', requireSession(deps), requireMembership(deps))
    .get('/', async (c) => {
      const league = await getLeague(deps.db, c.get('membership')!.leagueId);
      return c.json({ league } satisfies LeagueResponse);
    })
    .patch('/rules', async (c) => {
      const patch = await readJson(c, RulesBody);
      const league = await updateRules(deps, c.get('membership')!, patch);
      return c.json({ league } satisfies LeagueResponse);
    })
    .patch('/settings', async (c) => {
      const patch = await readJson(c, SettingsBody);
      const league = await updateSettings(deps, c.get('membership')!, patch);
      return c.json({ league } satisfies LeagueResponse);
    })
    .route('/', memberRoutes(deps))
    .route('/', leagueInviteRoutes(deps))
    .route('/', auditRoutes(deps))
    .route('/', gameRoutes(deps));
}
