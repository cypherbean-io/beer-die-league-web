import {
  checkRules,
  checkStructure,
  Game,
  type GamePlayer,
  type GameRevision,
  INBOX_MAX,
  playerLines,
  type SubmitGameBody,
} from '@beer-die/core';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import {
  confirmations,
  gameRevisions,
  games,
  leagues,
  memberships,
  revisionPlayers,
} from '../db/schema.ts';
import { ApiError } from '../http.ts';
import type { Actor } from './membership.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

type Deps = { db: Db; clock: Clock };

type Path = Array<string | number>;

type GameRow = typeof games.$inferSelect;

const invalid = (message: string, details: unknown) =>
  new ApiError(422, 'VALIDATION', message, details);

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

// A canonical form of everything but the idempotency key: fixed field order, lowercase ids,
// and a normalized time, so a retried draft hashes the same however its JSON was laid out.
function payloadHash(body: SubmitGameBody): string {
  return sha256Hex(
    JSON.stringify([
      body.kind,
      new Date(body.playedAt).toISOString(),
      playerLines(body.sides).map((p) => [p.side, p.membershipId.toLowerCase(), p.points, p.sinks]),
      body.winner,
      body.requestOverride ?? false,
    ]),
  );
}

// Maps a path into playerLines(body.sides) back onto the request's own shape.
function requestPath(body: SubmitGameBody, path: Path): Path {
  const [head, index, ...rest] = path;
  if (head !== 'players' || typeof index !== 'number') return path;
  const onA = body.sides.A.players.length;
  return index < onA
    ? ['sides', 'A', 'players', index, ...rest]
    : ['sides', 'B', 'players', index - onA, ...rest];
}

// The same submitter retrying the same key gets the game it created, as long as the payload
// matches, with a lapsed window settled first. Runs before any validation, so a retry still
// succeeds after the rules change.
async function findReplay(
  tx: Tx,
  actor: Actor,
  body: SubmitGameBody,
  payloadSha256: string,
  now: Date,
): Promise<Game | null> {
  const [existing] = await tx
    .select()
    .from(games)
    .where(
      and(
        eq(games.leagueId, actor.leagueId),
        eq(games.submittedBy, actor.id),
        eq(games.idempotencyKey, body.idempotencyKey),
      ),
    )
    .for('update');
  if (!existing) return null;
  if (existing.payloadSha256 !== payloadSha256) {
    throw new ApiError(
      409,
      'IDEMPOTENCY_MISMATCH',
      'A different game was already submitted with this idempotency key',
    );
  }
  await settleExpired(tx, existing, now);
  return loadGame(tx, existing.id);
}

// Records the first submission of an exhibition game: revision 1, open, with the
// submitter's confirmation. A game that breaks the rules is refused with RULES_VIOLATION
// unless the submitter asks for commissioner review. `leagueId` always comes from the
// actor's membership.
export async function submitGame(
  deps: Deps,
  actor: Actor,
  body: SubmitGameBody,
): Promise<{ game: Game; created: boolean }> {
  const now = deps.clock.now();
  const payloadSha256 = payloadHash(body);

  return deps.db.transaction(async (tx) => {
    const replay = await findReplay(tx, actor, body, payloadSha256, now);
    if (replay) return { game: replay, created: false };

    const [league] = await tx.select().from(leagues).where(eq(leagues.id, actor.leagueId));
    if (!league) throw new Error('league of a resolved membership is missing');
    const rules = {
      targetScore: league.targetScore,
      winBy: league.winBy,
      sinkPoints: league.sinkPoints,
      sinkEndsGame: league.sinkEndsGame,
    };
    const players = playerLines(body.sides);
    const result = { players, winner: body.winner };

    const structure = checkStructure(rules, result);
    if (structure.length > 0) {
      throw invalid(
        'The result is not a valid game',
        structure.map((e) => ({ ...e, path: requestPath(body, e.path) })),
      );
    }

    const ids = players.map((p) => p.membershipId.toLowerCase());
    if (!ids.includes(actor.id)) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only record a game you played in');
    }

    const playedAt = new Date(body.playedAt);
    if (playedAt.getTime() > now.getTime()) {
      throw invalid('A game cannot be played in the future', [
        { path: ['playedAt'], message: 'Choose a time that has already passed' },
      ]);
    }

    // FOR SHARE holds each player's membership as approved until this commits, so a
    // concurrent removal waits for the game and then sees it.
    const approved = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.leagueId, actor.leagueId),
          inArray(memberships.id, ids),
          eq(memberships.status, 'approved'),
        ),
      )
      .for('share');
    const approvedIds = new Set(approved.map((m) => m.id));
    const strangers = ids.flatMap((id, i) =>
      approvedIds.has(id)
        ? []
        : [
            {
              path: requestPath(body, ['players', i, 'membershipId']),
              message: 'Not an approved member of this league',
            },
          ],
    );
    if (strangers.length > 0) {
      throw invalid('Every player must be an approved member of this league', strangers);
    }

    const ruleViolations = checkRules(rules, result);
    if (ruleViolations.length > 0 && !body.requestOverride) {
      throw new ApiError(
        422,
        'RULES_VIOLATION',
        'The result breaks the league rules. A commissioner can review it.',
        ruleViolations,
      );
    }

    // A concurrent submission of the same key makes this insert wait for it to commit, then
    // insert nothing; that submission's game is then the replay.
    const [game] = await tx
      .insert(games)
      .values({
        leagueId: actor.leagueId,
        kind: body.kind,
        status: 'pending',
        windowExpiresAt: new Date(now.getTime() + league.confirmationWindowDays * DAY_MS),
        rulesSnapshot: rules,
        submittedBy: actor.id,
        idempotencyKey: body.idempotencyKey,
        payloadSha256,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [games.leagueId, games.submittedBy, games.idempotencyKey] })
      .returning({ id: games.id });
    if (!game) {
      const raced = await findReplay(tx, actor, body, payloadSha256, now);
      if (!raced) throw new Error('conflicting game is missing');
      return { game: raced, created: false };
    }

    const [revision] = await tx
      .insert(gameRevisions)
      .values({
        gameId: game.id,
        number: 1,
        status: 'open',
        createdBy: actor.id,
        playedAt,
        winner: body.winner,
        ruleViolations,
        overrideStatus: ruleViolations.length > 0 ? 'requested' : null,
        createdAt: now,
      })
      .returning({ id: gameRevisions.id });
    if (!revision) throw new Error('insert returned no revision');

    // An exhibition game has no teams, so nobody in it is a sub.
    await tx.insert(revisionPlayers).values(
      players.map((p, i) => ({
        revisionId: revision.id,
        side: p.side,
        membershipId: ids[i]!,
        isSub: false,
        points: p.points,
        sinks: p.sinks,
      })),
    );
    // Submitting counts as the submitter's confirmation.
    await tx.insert(confirmations).values({
      revisionId: revision.id,
      membershipId: actor.id,
      kind: 'player',
      createdAt: now,
    });
    await tx.update(games).set({ openRevisionId: revision.id }).where(eq(games.id, game.id));

    return { game: await loadGame(tx, game.id), created: true };
  });
}

// The start of every write to an existing game: its row, locked FOR UPDATE until the
// transaction ends so that transitions on one game happen one at a time, with a lapsed
// window settled before anything else. A game outside the caller's league is a 404, like an
// unknown one. Writes run at READ COMMITTED, so a write that waited on the lock then sees
// what the previous holder committed.
async function lockGame(tx: Tx, actor: Actor, gameId: string, now: Date): Promise<GameRow> {
  const [game] = await tx
    .select()
    .from(games)
    .where(and(eq(games.id, gameId), eq(games.leagueId, actor.leagueId)))
    .for('update');
  if (!game) throw notFound();
  return settleExpired(tx, game, now);
}

// Materializes a lapsed window: the open revision expires, and so does a game that never
// counted; one that did keeps its confirmed revision. Reads don't wait for this, because
// they treat `now ≥ window_expires_at` as expired. Runs under the game row lock.
async function settleExpired(tx: Tx, game: GameRow, now: Date): Promise<GameRow> {
  const { openRevisionId, windowExpiresAt } = game;
  if (!openRevisionId || !windowExpiresAt || now.getTime() < windowExpiresAt.getTime()) {
    return game;
  }
  await tx
    .update(gameRevisions)
    .set({ status: 'expired' })
    .where(and(eq(gameRevisions.id, openRevisionId), eq(gameRevisions.status, 'open')));
  const [settled] = await tx
    .update(games)
    .set({
      status: game.confirmedRevisionId === null ? 'expired' : game.status,
      openRevisionId: null,
      windowExpiresAt: null,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!settled) throw new Error('locked game is missing');
  return settled;
}

const SWEEP_BATCH = 100;
const SWEEP_MAX_BATCHES = 10;

// The worker's half of expiry: settles games whose window has lapsed, in every league, a
// batch per transaction and at most `maxBatches` batches per call, so a backlog can't hold
// up the rest of the worker. `done` is false when lapsed games may remain. A game a write
// holds locked is skipped; that write settles it itself. Correctness never depends on this
// running.
export async function sweepExpired(
  deps: Deps,
  {
    batchSize = SWEEP_BATCH,
    maxBatches = SWEEP_MAX_BATCHES,
  }: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ expired: number; done: boolean }> {
  for (const [name, value] of [
    ['batchSize', batchSize],
    ['maxBatches', maxBatches],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  const now = deps.clock.now();
  let expired = 0;
  for (let i = 0; i < maxBatches; i++) {
    // Settling clears open_revision_id, so a game never matches twice.
    const batch = await deps.db.transaction(async (tx) => {
      const lapsed = await tx
        .select()
        .from(games)
        .where(and(isNotNull(games.openRevisionId), lte(games.windowExpiresAt, now)))
        .orderBy(asc(games.windowExpiresAt), asc(games.id))
        .limit(batchSize)
        .for('update', { skipLocked: true });
      for (const game of lapsed) await settleExpired(tx, game, now);
      return lapsed.length;
    });
    expired += batch;
    if (batch < batchSize) return { expired, done: true };
  }
  return { expired, done: false };
}

// THE confirmation transition (SPEC §3.4), and the only code that confirms a revision. The
// game's open revision confirms once each of its four players has a confirmation and, if it
// breaks the rules, a commissioner has approved an override; it then becomes the revision
// stats read. Call it under the game row lock after any change that could complete the
// open revision. Until then it changes nothing.
async function settleRevision(tx: Tx, game: GameRow): Promise<void> {
  const revisionId = game.openRevisionId;
  if (!revisionId) return;
  const [revision] = await tx
    .select({
      status: gameRevisions.status,
      ruleViolations: gameRevisions.ruleViolations,
      overrideStatus: gameRevisions.overrideStatus,
    })
    .from(gameRevisions)
    .where(eq(gameRevisions.id, revisionId));
  if (!revision || revision.status !== 'open') return;
  if (revision.ruleViolations.length > 0 && revision.overrideStatus !== 'approved') return;

  const players = await tx
    .select({ confirmation: confirmations.id })
    .from(revisionPlayers)
    .leftJoin(
      confirmations,
      and(
        eq(confirmations.revisionId, revisionPlayers.revisionId),
        eq(confirmations.membershipId, revisionPlayers.membershipId),
      ),
    )
    .where(eq(revisionPlayers.revisionId, revisionId));
  if (players.length !== 4 || players.some((p) => p.confirmation === null)) return;

  await tx
    .update(gameRevisions)
    .set({ status: 'confirmed' })
    .where(eq(gameRevisions.id, revisionId));
  await tx
    .update(games)
    .set({
      status: 'confirmed',
      confirmedRevisionId: revisionId,
      openRevisionId: null,
      windowExpiresAt: null,
    })
    .where(eq(games.id, game.id));
}

// A player confirms the revision they were shown. If they have already confirmed it (or
// submitted it), the game comes back unchanged, whatever has happened to it since.
// Otherwise the revision must still be the game's open one.
export async function confirmRevision(
  deps: Deps,
  actor: Actor,
  gameId: string,
  revisionId: string,
): Promise<Game> {
  const now = deps.clock.now();
  // Path ids are matched case-insensitively; Postgres returns them in lower case.
  const rid = revisionId.toLowerCase();

  return deps.db.transaction(async (tx) => {
    const game = await lockGame(tx, actor, gameId, now);
    const [revision] = await tx
      .select({ status: gameRevisions.status })
      .from(gameRevisions)
      .where(and(eq(gameRevisions.id, rid), eq(gameRevisions.gameId, game.id)));
    if (!revision) throw notFound();

    const [seat] = await tx
      .select({ confirmation: confirmations.id })
      .from(revisionPlayers)
      .leftJoin(
        confirmations,
        and(
          eq(confirmations.revisionId, revisionPlayers.revisionId),
          eq(confirmations.membershipId, revisionPlayers.membershipId),
        ),
      )
      .where(and(eq(revisionPlayers.revisionId, rid), eq(revisionPlayers.membershipId, actor.id)));
    if (!seat) throw new ApiError(403, 'FORBIDDEN', 'Only the players in a game can confirm it');
    if (seat.confirmation !== null) return loadGame(tx, game.id);

    if (revision.status === 'expired') {
      throw new ApiError(409, 'WINDOW_CLOSED', 'The window to confirm this game has closed');
    }
    if (revision.status !== 'open' || game.openRevisionId !== rid) {
      throw new ApiError(
        409,
        'STALE_REVISION',
        'This version of the game can no longer be confirmed',
      );
    }

    await tx.insert(confirmations).values({
      revisionId: rid,
      membershipId: actor.id,
      kind: 'player',
      createdAt: now,
    });
    await settleRevision(tx, game);
    return loadGame(tx, game.id);
  });
}

// Games whose open revision awaits the caller's confirmation, soonest to expire first, up to
// INBOX_MAX. A lapsed window counts as expired here even before any write has settled it.
export async function listInbox(deps: Deps, actor: Actor): Promise<Game[]> {
  const now = deps.clock.now();

  // One snapshot, so each game is loaded in the state that put it in the inbox.
  return deps.db.transaction(
    async (tx) => {
      const awaiting = await tx
        .select({ id: games.id })
        .from(games)
        .innerJoin(gameRevisions, eq(gameRevisions.id, games.openRevisionId))
        .innerJoin(
          revisionPlayers,
          and(
            eq(revisionPlayers.revisionId, gameRevisions.id),
            eq(revisionPlayers.membershipId, actor.id),
          ),
        )
        .leftJoin(
          confirmations,
          and(
            eq(confirmations.revisionId, gameRevisions.id),
            eq(confirmations.membershipId, actor.id),
          ),
        )
        .where(
          and(
            eq(games.leagueId, actor.leagueId),
            eq(gameRevisions.status, 'open'),
            gt(games.windowExpiresAt, now),
            isNull(confirmations.id),
          ),
        )
        .orderBy(asc(games.windowExpiresAt), asc(games.id))
        .limit(INBOX_MAX);
      return loadGames(
        tx,
        awaiting.map((g) => g.id),
      );
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function loadRevisions(tx: Tx, ids: string[]): Promise<Map<string, GameRevision>> {
  if (ids.length === 0) return new Map();
  const revisions = await tx.select().from(gameRevisions).where(inArray(gameRevisions.id, ids));
  const players = await tx
    .select({
      revisionId: revisionPlayers.revisionId,
      membershipId: revisionPlayers.membershipId,
      displayName: memberships.displayName,
      side: revisionPlayers.side,
      points: revisionPlayers.points,
      sinks: revisionPlayers.sinks,
      isSub: revisionPlayers.isSub,
      confirmation: confirmations.kind,
    })
    .from(revisionPlayers)
    .innerJoin(memberships, eq(memberships.id, revisionPlayers.membershipId))
    .leftJoin(
      confirmations,
      and(
        eq(confirmations.revisionId, revisionPlayers.revisionId),
        eq(confirmations.membershipId, revisionPlayers.membershipId),
      ),
    )
    .where(inArray(revisionPlayers.revisionId, ids))
    // The players were inserted in request order, and UUIDv7 ids are time-ordered.
    .orderBy(asc(revisionPlayers.side), asc(revisionPlayers.id));

  const playersOf = new Map<string, GamePlayer[]>();
  for (const { revisionId, ...player } of players) {
    playersOf.set(revisionId, [...(playersOf.get(revisionId) ?? []), player]);
  }
  return new Map(
    revisions.map((revision) => [
      revision.id,
      {
        id: revision.id,
        number: revision.number,
        status: revision.status,
        createdBy: revision.createdBy,
        playedAt: revision.playedAt.toISOString(),
        winner: revision.winner,
        players: playersOf.get(revision.id) ?? [],
        ruleViolations: revision.ruleViolations,
        overrideStatus: revision.overrideStatus,
      },
    ]),
  );
}

// Loads games in the order of `ids`, with their revisions in a fixed number of queries.
async function loadGames(tx: Tx, ids: string[]): Promise<Game[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(games).where(inArray(games.id, ids));
  const revisions = await loadRevisions(
    tx,
    rows.flatMap((g) => [g.openRevisionId, g.confirmedRevisionId].filter((id) => id !== null)),
  );
  const revision = (id: string | null) => {
    if (id === null) return null;
    const loaded = revisions.get(id);
    if (!loaded) throw new Error('referenced revision is missing');
    return loaded;
  };
  const byId = new Map(rows.map((g) => [g.id, g]));

  return ids.map((id) => {
    const game = byId.get(id);
    if (!game) throw new Error('game is missing');
    // Parsed rather than cast: a jsonb column whose stored shape has drifted fails here,
    // loudly, instead of reaching clients.
    return Game.parse({
      id: game.id,
      kind: game.kind,
      status: game.status,
      rulesSnapshot: game.rulesSnapshot,
      windowExpiresAt: game.windowExpiresAt?.toISOString() ?? null,
      openRevision: revision(game.openRevisionId),
      confirmedRevision: revision(game.confirmedRevisionId),
    });
  });
}

async function loadGame(tx: Tx, gameId: string): Promise<Game> {
  const [game] = await loadGames(tx, [gameId]);
  return game!;
}
