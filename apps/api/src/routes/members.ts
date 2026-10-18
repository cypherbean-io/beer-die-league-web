import { EmptyBody, type MemberResponse, type MembersResponse, RoleBody } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import { approveMember, listMembers, rejectMember, setRole } from '../domain/membership.ts';
import { idParam, readJson } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function memberRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>()
    .get('/members', async (c) => {
      const members = await listMembers(deps.db, c.get('membership')!);
      return c.json({ members } satisfies MembersResponse);
    })
    .post('/members/:mid/approve', async (c) => {
      await readJson(c, EmptyBody);
      const member = await approveMember(deps.db, c.get('membership')!, idParam(c, 'mid'));
      return c.json({ member } satisfies MemberResponse);
    })
    .post('/members/:mid/reject', async (c) => {
      await readJson(c, EmptyBody);
      await rejectMember(deps.db, c.get('membership')!, idParam(c, 'mid'));
      return c.body(null, 204);
    })
    .post('/members/:mid/role', async (c) => {
      const { role } = await readJson(c, RoleBody);
      const member = await setRole(deps.db, c.get('membership')!, idParam(c, 'mid'), role);
      return c.json({ member } satisfies MemberResponse);
    });
}
