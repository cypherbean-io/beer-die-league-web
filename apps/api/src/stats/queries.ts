import type { PlayerStats, StatsScope } from '@beer-die/core';
import { and, asc, desc, eq, exists, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { countedResults, memberships } from '../db/schema.ts';
import type { Actor } from '../domain/membership.ts';
import { ApiError } from '../http.ts';

function inScope(scope: StatsScope): SQL | undefined {
  switch (scope) {
    case 'alltime':
      return eq(countedResults.kind, 'season');
    case 'exhibition':
      return eq(countedResults.kind, 'exhibition');
    case 'combined':
      return undefined;
  }
}

// Counting the game id rather than rows gives 0 for a player with no rows in a left join.
const totals = {
  gamesPlayed: sql<number>`count(${countedResults.gameId})::int`,
  wins: sql<number>`(count(${countedResults.gameId}) filter (where ${countedResults.won}))::int`,
  points: sql<number>`coalesce(sum(${countedResults.points}), 0)::int`,
  sinks: sql<number>`coalesce(sum(${countedResults.sinks}), 0)::int`,
};

const player = { membershipId: memberships.id, displayName: memberships.displayName };

type Totals = { membershipId: string; displayName: string } & {
  [K in keyof typeof totals]: number;
};

function withRates(row: Totals): PlayerStats {
  const { gamesPlayed, wins, points, sinks } = row;
  const perGame = (n: number) => (gamesPlayed === 0 ? null : n / gamesPlayed);
  return {
    membershipId: row.membershipId,
    displayName: row.displayName,
    gamesPlayed,
    wins,
    losses: gamesPlayed - wins,
    winPct: perGame(wins),
    points,
    pointsPerGame: perGame(points),
    sinks,
    sinksPerGame: perGame(sinks),
  };
}

// Every player with a counted game in the scope, by wins, then points, then name. Each
// statement reads one snapshot, so a game confirmed meanwhile counts for all four or none.
export async function listPlayerStats(
  db: Db,
  actor: Actor,
  scope: StatsScope,
): Promise<PlayerStats[]> {
  const rows = await db
    .select({ ...player, ...totals })
    .from(countedResults)
    .innerJoin(memberships, eq(memberships.id, countedResults.membershipId))
    .where(
      and(
        eq(countedResults.leagueId, actor.leagueId),
        eq(memberships.leagueId, actor.leagueId),
        inScope(scope),
      ),
    )
    .groupBy(memberships.id)
    .orderBy(desc(totals.wins), desc(totals.points), asc(memberships.nameKey), asc(memberships.id));
  return rows.map(withRates);
}

// One player's line in the scope, zeros included. The profile shows an approved member, or a
// former one whose confirmed games still count in some scope. Anyone else (a pending member,
// whom only commissioners may know about, or a former member with no counted games) gets the
// same 404 as an unknown id.
export async function getPlayerStats(
  db: Db,
  actor: Actor,
  membershipId: string,
  scope: StatsScope,
): Promise<PlayerStats> {
  const [row] = await db
    .select({ ...player, ...totals })
    .from(memberships)
    .leftJoin(
      countedResults,
      and(
        eq(countedResults.membershipId, memberships.id),
        eq(countedResults.leagueId, memberships.leagueId),
        inScope(scope),
      ),
    )
    .where(
      and(
        eq(memberships.id, membershipId),
        eq(memberships.leagueId, actor.leagueId),
        or(
          eq(memberships.status, 'approved'),
          exists(
            db
              .select({ one: sql`1` })
              .from(countedResults)
              .where(
                and(
                  eq(countedResults.membershipId, memberships.id),
                  eq(countedResults.leagueId, memberships.leagueId),
                ),
              ),
          ),
        ),
      ),
    )
    .groupBy(memberships.id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  return withRates(row);
}
