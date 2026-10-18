import type { PartnershipStats, PlayerStats, StatsScope } from '@beer-die/core';
import { and, asc, desc, eq, exists, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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

// A pair's totals, from both partners' rows in each game they played together: points and
// sinks add up the two players, and each game counts once.
const pairTotals = {
  gamesPlayed: sql<number>`count(distinct ${countedResults.gameId})::int`,
  wins: sql<number>`(count(distinct ${countedResults.gameId}) filter (where ${countedResults.won}))::int`,
  points: sql<number>`sum(${countedResults.points})::int`,
  sinks: sql<number>`sum(${countedResults.sinks})::int`,
};

// The SQL twin of pairKey: whichever partner a row belongs to, `first` is the lower id.
const first = alias(memberships, 'first');
const second = alias(memberships, 'second');
const firstId = sql`least(${countedResults.membershipId}, ${countedResults.partnerMembershipId})`;
const secondId = sql`greatest(${countedResults.membershipId}, ${countedResults.partnerMembershipId})`;

// Every pair with a counted game in the scope, by wins, then points, then names. As with
// players, one statement reads one snapshot.
export async function listPartnershipStats(
  db: Db,
  actor: Actor,
  scope: StatsScope,
): Promise<PartnershipStats[]> {
  const rows = await db
    .select({
      first: { membershipId: first.id, displayName: first.displayName },
      second: { membershipId: second.id, displayName: second.displayName },
      ...pairTotals,
    })
    .from(countedResults)
    .innerJoin(first, eq(first.id, firstId))
    .innerJoin(second, eq(second.id, secondId))
    .where(
      and(
        eq(countedResults.leagueId, actor.leagueId),
        eq(first.leagueId, actor.leagueId),
        eq(second.leagueId, actor.leagueId),
        inScope(scope),
      ),
    )
    .groupBy(first.id, second.id)
    .orderBy(
      desc(pairTotals.wins),
      desc(pairTotals.points),
      asc(sql`least(${first.nameKey}, ${second.nameKey})`),
      asc(sql`greatest(${first.nameKey}, ${second.nameKey})`),
      asc(first.id),
      asc(second.id),
    );
  return rows.map(({ first, second, gamesPlayed, wins, points, sinks }) => ({
    players: [first, second],
    gamesPlayed,
    wins,
    losses: gamesPlayed - wins,
    winPct: wins / gamesPlayed,
    points,
    sinks,
  }));
}
