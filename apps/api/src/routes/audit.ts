import { AuditQuery, type AuditResponse } from '@beer-die/core';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { LeagueEnv } from '../auth/middleware.ts';
import { listAudit } from '../domain/audit.ts';
import { readQuery } from '../http.ts';

// Mounted inside leagueRoutes, which has already resolved the caller's membership.
export function auditRoutes(deps: AppDeps) {
  return new Hono<LeagueEnv>().get('/audit', async (c) => {
    const query = readQuery(c, AuditQuery);
    const page = await listAudit(deps.db, c.get('membership')!, query);
    return c.json(page satisfies AuditResponse);
  });
}
