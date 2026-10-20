import {
  CreateSeasonBody,
  EmptyBody,
  type SeasonResponse,
  type SeasonsResponse,
  StandingsConfigBody,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import {
  createSeason,
  endSeason,
  listSeasons,
  startSeason,
  updateStandingsConfig,
} from '../domain/seasons.ts';
import { idParam, readJson } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function seasonRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .get('/seasons', async (c) => {
      const seasons = await listSeasons(deps.db, c.get('membership')!);
      return c.json({ seasons } satisfies SeasonsResponse);
    })
    .post('/seasons', async (c) => {
      const body = await readJson(c, CreateSeasonBody);
      const season = await createSeason(deps, c.get('membership')!, body);
      return c.json({ season } satisfies SeasonResponse, 201);
    })
    .post('/seasons/:sid/start', async (c) => {
      await readJson(c, EmptyBody);
      const season = await startSeason(deps, c.get('membership')!, idParam(c, 'sid'));
      return c.json({ season } satisfies SeasonResponse);
    })
    .post('/seasons/:sid/end', async (c) => {
      await readJson(c, EmptyBody);
      const season = await endSeason(deps, c.get('membership')!, idParam(c, 'sid'));
      return c.json({ season } satisfies SeasonResponse);
    })
    .patch('/seasons/:sid/standings-config', async (c) => {
      const patch = await readJson(c, StandingsConfigBody);
      const season = await updateStandingsConfig(
        deps,
        c.get('membership')!,
        idParam(c, 'sid'),
        patch,
      );
      return c.json({ season } satisfies SeasonResponse);
    });
}
