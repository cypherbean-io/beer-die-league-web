import { type GameResponse, SubmitGameBody } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import { submitGame } from '../domain/games.ts';
import { readJson } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function gameRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>().post('/games', async (c) => {
    const body = await readJson(c, SubmitGameBody);
    const { game, created } = await submitGame(deps, c.get('membership')!, body);
    // A retry with the same idempotency key and payload returns the original game.
    return c.json({ game } satisfies GameResponse, created ? 201 : 200);
  });
}
