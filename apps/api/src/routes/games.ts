import {
  CorrectGameBody,
  EmptyBody,
  ForceConfirmBody,
  type GameResponse,
  OverrideDecisionBody,
  SubmitGameBody,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import {
  confirmRevision,
  correctGame,
  decideOverride,
  forceConfirm,
  submitGame,
} from '../domain/games.ts';
import { idParam, readJson } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function gameRoutes(deps: AppDeps) {
  return (
    new Hono<LeagueEnv>()
      .post('/games', async (c) => {
        const body = await readJson(c, SubmitGameBody);
        const { game, created } = await submitGame(deps, c.get('membership')!, body);
        // A retry with the same idempotency key and payload returns the original game.
        return c.json({ game } satisfies GameResponse, created ? 201 : 200);
      })
      // A correction names the revision it was based on, so it can't overwrite numbers its
      // author hasn't seen.
      .post('/games/:gid/revisions', async (c) => {
        const body = await readJson(c, CorrectGameBody);
        const game = await correctGame(deps, c.get('membership')!, idParam(c, 'gid'), body);
        return c.json({ game } satisfies GameResponse, 201);
      })
      // The client sends the revision id it displayed, so nobody confirms numbers they haven't
      // seen.
      .post('/games/:gid/revisions/:rid/confirm', async (c) => {
        await readJson(c, EmptyBody);
        const game = await confirmRevision(
          deps,
          c.get('membership')!,
          idParam(c, 'gid'),
          idParam(c, 'rid'),
        );
        return c.json({ game } satisfies GameResponse);
      })
      // A commissioner confirms for silent players, again on the revision they displayed.
      .post('/games/:gid/revisions/:rid/force-confirm', async (c) => {
        const body = await readJson(c, ForceConfirmBody);
        const game = await forceConfirm(
          deps,
          c.get('membership')!,
          idParam(c, 'gid'),
          idParam(c, 'rid'),
          body,
        );
        return c.json({ game } satisfies GameResponse);
      })
      // A commissioner approves or rejects the rule-breaking revision they displayed.
      .post('/games/:gid/revisions/:rid/override', async (c) => {
        const body = await readJson(c, OverrideDecisionBody);
        const game = await decideOverride(
          deps,
          c.get('membership')!,
          idParam(c, 'gid'),
          idParam(c, 'rid'),
          body,
        );
        return c.json({ game } satisfies GameResponse);
      })
  );
}
