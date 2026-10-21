import { DEFAULT_STANDINGS_CONFIG, Season, type StandingsConfig } from '@beer-die/core';
import { and, desc, eq, isNotNull, notInArray } from 'drizzle-orm';
import { hit, rateLimitKey } from '../auth/rateLimit.ts';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { games, seasons } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { recordAudit } from './audit.ts';
import { expireLapsed } from './expiry.ts';
import { lockForCommissionerEdit } from './leagues.ts';
import { type Actor, assertCommissioner } from './membership.ts';

// The season lifecycle (SPEC §3.7): draft → active → ended → finalized. A commissioner starts
// and ends a season; it finalizes on its own once it has ended and none of its games has an
// open revision, which locks its standings config.
//
// Lock order: a commissioner's edit takes the league row, then the season row; a game write
// takes the game row, then the season row. Nothing takes a league or game lock while holding
// a season lock, so the two paths can't deadlock. Season rows are locked FOR NO KEY UPDATE,
// which a status change needs, and which leaves foreign-key checks on the season unblocked.
// Submitting a season game, or reopening one, holds its season FOR SHARE instead, until it
// commits: the season can't end, and its teams can't change, under the game, and that write
// never asks for the season lock in a stronger mode, so two of them can't deadlock upgrading.

// Drafts can't be deleted and every member loads the list, so a commissioner's creations are
// capped. Far above what a real league needs.
export const SEASON_CREATES_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

type Deps = { db: Db; clock: Clock };

type SeasonRow = typeof seasons.$inferSelect;

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

export function toSeason(row: SeasonRow): Season {
  // Parsed rather than cast: a jsonb column whose stored shape has drifted fails here,
  // loudly, instead of reaching clients.
  return Season.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    standingsConfig: row.standingsConfig,
  });
}

// Every member sees every season in their league, newest first.
export async function listSeasons(db: Db, actor: Actor): Promise<Season[]> {
  const rows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.leagueId, actor.leagueId))
    .orderBy(desc(seasons.createdAt), desc(seasons.id));
  return rows.map(toSeason);
}

// A new season starts as a draft, with the default standings config. Drafts change nothing
// until one is started, so creating one isn't audited.
export async function createSeason(
  deps: Deps & { config: { authSecret: string } },
  actor: Actor,
  body: { name: string },
): Promise<Season> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  // Counted outside the transaction, so a refused attempt still counts.
  const key = rateLimitKey(deps.config.authSecret, 'season-create', actor.id);
  if (!(await hit(deps.db, key, SEASON_CREATES_PER_HOUR, HOUR_MS, now))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many seasons created. Try again later.');
  }
  return deps.db.transaction(async (tx) => {
    await lockForCommissionerEdit(tx, actor);
    const [row] = await tx
      .insert(seasons)
      .values({
        leagueId: actor.leagueId,
        name: body.name,
        status: 'draft',
        standingsConfig: DEFAULT_STANDINGS_CONFIG,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('insert returned no season');
    return toSeason(row);
  });
}

// The start of every commissioner write to a season: the league lock and role re-check every
// commissioner edit takes, then the season's row. A season outside the caller's league is a
// 404, like an unknown one.
async function lockSeasonForEdit(tx: Tx, actor: Actor, seasonId: string): Promise<SeasonRow> {
  await lockForCommissionerEdit(tx, actor);
  const [season] = await tx
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.leagueId, actor.leagueId)))
    .for('no key update');
  if (!season) throw notFound();
  return season;
}

// Finalizes an ended season once none of its games has an open revision; any other season
// comes back unchanged. Runs with the season row locked.
//
// A game whose row a write holds counts as open: the write may still confirm it (its `now`
// was read before it waited for the lock), and once it closes the game it settles the season
// itself. Every other open game is locked here, so none can change underneath. Those whose
// window has lapsed count as closed, as they do for reads, and their expiry is recorded before
// the season finalizes, so a write that was waiting on one then finds it closed. SKIP LOCKED
// never waits on a game while the season is held, which keeps the lock order intact.
export async function finalizeIfSettled(tx: Tx, season: SeasonRow, now: Date): Promise<SeasonRow> {
  if (season.status !== 'ended') return season;
  const openInSeason = and(eq(games.seasonId, season.id), isNotNull(games.openRevisionId));
  const free = await tx
    .select()
    .from(games)
    .where(openInSeason)
    .for('update', { skipLocked: true });
  // A game with no window never lapses.
  const lapsed = (g: (typeof free)[number]) =>
    g.windowExpiresAt !== null && now.getTime() >= g.windowExpiresAt.getTime();
  if (!free.every(lapsed)) return season;
  const [held] = await tx
    .select({ id: games.id })
    .from(games)
    .where(
      and(
        openInSeason,
        free.length > 0
          ? notInArray(
              games.id,
              free.map((g) => g.id),
            )
          : undefined,
      ),
    )
    .limit(1);
  if (held) return season;

  for (const game of free) await expireLapsed(tx, game, now);
  const [finalized] = await tx
    .update(seasons)
    .set({ status: 'finalized', finalizedAt: now })
    .where(eq(seasons.id, season.id))
    .returning();
  if (!finalized) throw new Error('locked season vanished');
  return finalized;
}

// Called under a season game's row lock once its open revision has closed, by confirming or
// expiring, and finalizes the game's season if that was the last one open. The season lock
// serializes these checks: when two of an ended season's last games close at once, or one
// closes while the season is being ended, whichever checks second sees what the first
// committed, so the season always finalizes. The caller's own game lock doesn't hide any of
// its games from finalizeIfSettled, since a transaction never waits on its own locks.
export async function settleSeason(tx: Tx, seasonId: string, now: Date): Promise<void> {
  const [season] = await tx
    .select()
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .for('no key update');
  if (!season) throw new Error('season of a season game is missing');
  await finalizeIfSettled(tx, season, now);
}

// Makes a draft season the league's active one. Starting the active season again returns it
// unchanged; any other season can't be started.
export async function startSeason(deps: Deps, actor: Actor, seasonId: string): Promise<Season> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const season = await lockSeasonForEdit(tx, actor, seasonId);
    if (season.status === 'active') return toSeason(season);
    if (season.status !== 'draft') {
      throw new ApiError(409, 'SEASON_NOT_DRAFT', 'Only a draft season can be started');
    }
    // Starts are serialized on the league lock, so this sees any season started before it.
    // The partial unique index on active seasons backs it up.
    const [running] = await tx
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.leagueId, actor.leagueId), eq(seasons.status, 'active')));
    if (running) {
      throw new ApiError(
        409,
        'SEASON_ALREADY_ACTIVE',
        'Another season is active. End it before starting this one',
      );
    }

    const [started] = await tx
      .update(seasons)
      .set({ status: 'active', startedAt: now })
      .where(eq(seasons.id, season.id))
      .returning();
    if (!started) throw new Error('locked season vanished');
    await recordAudit(
      tx,
      actor,
      {
        action: 'season.started',
        targetType: 'season',
        targetId: season.id,
        actorWasParticipant: false,
        details: {},
      },
      now,
    );
    return toSeason(started);
  });
}

// Ends the active season. Games already open in it can still be corrected and confirmed
// until their windows close; it finalizes now if none is open, or else once the last one
// closes. Ending it again returns it as it stands; a draft can't be ended.
export async function endSeason(deps: Deps, actor: Actor, seasonId: string): Promise<Season> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const season = await lockSeasonForEdit(tx, actor, seasonId);
    if (season.status === 'ended' || season.status === 'finalized') {
      return toSeason(await finalizeIfSettled(tx, season, now));
    }
    if (season.status !== 'active') {
      throw new ApiError(409, 'SEASON_NOT_ACTIVE', 'Only an active season can be ended');
    }

    const [ended] = await tx
      .update(seasons)
      .set({ status: 'ended', endedAt: now })
      .where(eq(seasons.id, season.id))
      .returning();
    if (!ended) throw new Error('locked season vanished');
    await recordAudit(
      tx,
      actor,
      {
        action: 'season.ended',
        targetType: 'season',
        targetId: season.id,
        actorWasParticipant: false,
        details: {},
      },
      now,
    );
    return toSeason(await finalizeIfSettled(tx, ended, now));
  });
}

function sameConfig(a: StandingsConfig, b: StandingsConfig): boolean {
  return (
    a.minGames === b.minGames &&
    a.order.length === b.order.length &&
    a.order.every((metric, i) => metric === b.order[i])
  );
}

// Changes how the season's standings rank teams, at any time until it is finalized. A
// change that matches the current config writes nothing and isn't audited.
export async function updateStandingsConfig(
  deps: Deps,
  actor: Actor,
  seasonId: string,
  patch: Partial<StandingsConfig>,
): Promise<Season> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  // Null when the season is finalized. The change is refused only after this commits, so a
  // season that finalizes here, because its last open game's window has lapsed, stays
  // finalized.
  const updated = await deps.db.transaction(async (tx) => {
    const season = await finalizeIfSettled(tx, await lockSeasonForEdit(tx, actor, seasonId), now);
    if (season.status === 'finalized') return null;

    const before = season.standingsConfig;
    const after: StandingsConfig = {
      order: patch.order ?? before.order,
      minGames: patch.minGames ?? before.minGames,
    };
    if (sameConfig(before, after)) return toSeason(season);

    const [row] = await tx
      .update(seasons)
      .set({ standingsConfig: after })
      .where(eq(seasons.id, season.id))
      .returning();
    if (!row) throw new Error('locked season vanished');
    await recordAudit(
      tx,
      actor,
      {
        action: 'season.standings_config_updated',
        targetType: 'season',
        targetId: season.id,
        actorWasParticipant: false,
        details: { before, after },
      },
      now,
    );
    return toSeason(row);
  });
  if (!updated) {
    throw new ApiError(
      409,
      'SEASON_FINALIZED',
      'This season is finalized, so its standings settings are locked',
    );
  }
  return updated;
}
