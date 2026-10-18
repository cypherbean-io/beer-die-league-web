import {
  type CreateInviteResponse,
  EmptyBody,
  type InvitesResponse,
  JoinBody,
  type JoinResponse,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { type AuthEnv, type LeagueEnv, requireSession } from '../auth/middleware.ts';
import { createInvite, joinLeague, listInvites, revokeInvite } from '../domain/membership.ts';
import { idParam, readJson } from '../http.ts';

// The token is part of the path, so the access log records only the route template.
export function inviteRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>().post('/invites/:token/join', requireSession(deps), async (c) => {
    const { displayName } = await readJson(c, JoinBody);
    const membership = await joinLeague(deps, {
      userId: c.get('auth')!.userId,
      token: c.req.param('token'),
      displayName,
    });
    return c.json({ membership } satisfies JoinResponse, 201);
  });
}

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function leagueInviteRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .post('/invites', async (c) => {
      await readJson(c, EmptyBody);
      const created = await createInvite(deps, c.get('membership')!);
      return c.json(created satisfies CreateInviteResponse, 201);
    })
    .get('/invites', async (c) => {
      const invites = await listInvites(deps.db, c.get('membership')!, deps.clock.now());
      return c.json({ invites } satisfies InvitesResponse);
    })
    .delete('/invites/:iid', async (c) => {
      await revokeInvite(deps.db, c.get('membership')!, idParam(c, 'iid'), deps.clock.now());
      return c.body(null, 204);
    });
}
