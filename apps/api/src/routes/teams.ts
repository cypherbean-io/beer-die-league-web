import {
  EmptyBody,
  ProposeTeamBody,
  RosterBody,
  type TeamResponse,
  type TeamsResponse,
} from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import {
  acceptTeam,
  approveTeam,
  listTeams,
  proposeTeam,
  rejectTeam,
  setRoster,
  withdrawTeam,
} from '../domain/teams.ts';
import { idParam, readJson } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function teamRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .get('/seasons/:sid/teams', async (c) => {
      const teams = await listTeams(deps.db, c.get('membership')!, idParam(c, 'sid'));
      return c.json({ teams } satisfies TeamsResponse);
    })
    .post('/seasons/:sid/teams', async (c) => {
      const body = await readJson(c, ProposeTeamBody);
      const team = await proposeTeam(deps, c.get('membership')!, idParam(c, 'sid'), body);
      return c.json({ team } satisfies TeamResponse, 201);
    })
    .post('/teams/:tid/accept', async (c) => {
      await readJson(c, EmptyBody);
      const team = await acceptTeam(deps, c.get('membership')!, idParam(c, 'tid'));
      return c.json({ team } satisfies TeamResponse);
    })
    .post('/teams/:tid/withdraw', async (c) => {
      await readJson(c, EmptyBody);
      const team = await withdrawTeam(deps, c.get('membership')!, idParam(c, 'tid'));
      return c.json({ team } satisfies TeamResponse);
    })
    .post('/teams/:tid/approve', async (c) => {
      await readJson(c, EmptyBody);
      const team = await approveTeam(deps, c.get('membership')!, idParam(c, 'tid'));
      return c.json({ team } satisfies TeamResponse);
    })
    .post('/teams/:tid/reject', async (c) => {
      await readJson(c, EmptyBody);
      const team = await rejectTeam(deps, c.get('membership')!, idParam(c, 'tid'));
      return c.json({ team } satisfies TeamResponse);
    })
    .put('/teams/:tid/roster', async (c) => {
      const { membershipIds } = await readJson(c, RosterBody);
      const team = await setRoster(deps, c.get('membership')!, idParam(c, 'tid'), membershipIds);
      return c.json({ team } satisfies TeamResponse);
    });
}
