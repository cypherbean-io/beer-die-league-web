import {
  type PartnershipStats,
  type PlayerStats,
  rankStandings,
  scopeSeasonId,
  type StandingsGame,
  type StandingsResponse,
  type StatsScope,
  type TeamLine,
} from '@beer-die/core';
import { and, asc, desc, eq, exists, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import { countedResults, memberships, seasons, seasonTeams } from '../db/schema.ts';
import type { Actor } from '../domain/membership.ts';
import { toSeason } from '../domain/seasons.ts';
import { ApiError } from '../http.ts';

function inScope(scope: StatsScope): SQL | undefined {
  switch (scope) {
    case 'alltime':
      return eq(countedResults.kind, 'season');
    case 'exhibition':
      return eq(countedResults.kind, 'exhibition');
    case 'combined':
      return undefined;
    default:
      return eq(countedResults.seasonId, scopeSeasonId(scope)!);
  }
}

// A season scope must name one of the caller's league's seasons; any other id gets the same
// 404 as an unknown one, so the API doesn't reveal another league's seasons.
async function checkScope(db: Db, actor: Actor, scope: StatsScope): Promise<void> {
  const seasonId = scopeSeasonId(scope);
  if (seasonId === null) return;
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.leagueId, actor.leagueId)));
  if (!season) throw new ApiError(404, 'NOT_FOUND', 'Not found');
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
  await checkScope(db, actor, scope);
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
  await checkScope(db, actor, scope);
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
  await checkScope(db, actor, scope);
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

// Each team's side of each counted game in a season: its players' points and sinks, subs
// included. Two rows per game, one of them the winner's.
const teamSide = {
  gameId: countedResults.gameId,
  teamId: countedResults.teamId,
  won: sql<boolean>`bool_and(${countedResults.won})`,
  points: sql<number>`sum(${countedResults.points})::int`,
  sinks: sql<number>`sum(${countedResults.sinks})::int`,
};

// A season's standings (SPEC §3.7): its approved teams, ranked by its standings config from
// the confirmed games between them. Every member may read them; only approved teams are listed,
// and every member sees those anyway. A season outside the caller's league is a 404, like an
// unknown one. The reads share one snapshot, so the config, teams, and games are all from the
// same moment. Approving a team is final, and a season game names two approved teams, so every
// team a counted game names is listed.
export async function getStandings(
  db: Db,
  actor: Actor,
  seasonId: string,
): Promise<StandingsResponse> {
  return db.transaction(
    async (tx) => {
      const [season] = await tx
        .select()
        .from(seasons)
        .where(and(eq(seasons.id, seasonId), eq(seasons.leagueId, actor.leagueId)));
      if (!season) throw new ApiError(404, 'NOT_FOUND', 'Not found');
      const teams = await tx
        .select({ id: seasonTeams.id, name: seasonTeams.name })
        .from(seasonTeams)
        .where(and(eq(seasonTeams.seasonId, season.id), eq(seasonTeams.status, 'approved')));
      const sides = await tx
        .select(teamSide)
        .from(countedResults)
        .where(
          and(eq(countedResults.leagueId, actor.leagueId), eq(countedResults.seasonId, season.id)),
        )
        .groupBy(countedResults.gameId, countedResults.teamId);

      const byGame = new Map<string, Partial<StandingsGame>>();
      for (const { gameId, teamId, won, points, sinks } of sides) {
        if (teamId === null) throw new Error('a counted season game has a side with no team');
        const game = byGame.get(gameId) ?? {};
        const line: TeamLine = { teamId, points, sinks };
        if (won) game.winner = line;
        else game.loser = line;
        byGame.set(gameId, game);
      }
      const games = [...byGame.values()].map(({ winner, loser }) => {
        if (!winner || !loser) throw new Error('a counted season game lacks a winner or a loser');
        return { winner, loser };
      });

      const parsed = toSeason(season);
      return {
        season: parsed,
        standings: rankStandings(teams, games, parsed.standingsConfig),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
