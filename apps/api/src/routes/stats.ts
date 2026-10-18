import {
  PartnershipStatsQuery,
  type PartnershipStatsResponse,
  type PlayerStatResponse,
  PlayerStatsQuery,
  type PlayerStatsResponse,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import { idParam, readQuery } from '../http.ts';
import { getPlayerStats, listPartnershipStats, listPlayerStats } from '../stats/queries.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership. Every
// member may read the stats.
export function statsRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .get('/stats/players', async (c) => {
      const { scope } = readQuery(c, PlayerStatsQuery);
      const players = await listPlayerStats(deps.db, c.get('membership')!, scope);
      return c.json({ players } satisfies PlayerStatsResponse);
    })
    .get('/stats/players/:mid', async (c) => {
      const { scope } = readQuery(c, PlayerStatsQuery);
      const player = await getPlayerStats(deps.db, c.get('membership')!, idParam(c, 'mid'), scope);
      return c.json({ player } satisfies PlayerStatResponse);
    })
    .get('/stats/partnerships', async (c) => {
      const { scope } = readQuery(c, PartnershipStatsQuery);
      const partnerships = await listPartnershipStats(deps.db, c.get('membership')!, scope);
      return c.json({ partnerships } satisfies PartnershipStatsResponse);
    });
}
