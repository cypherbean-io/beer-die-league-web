import {
  checkRules,
  checkStructure,
  Game,
  type GameRevision,
  playerLines,
  type SubmitGameBody,
} from '@beer-die/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
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

const invalid = (message: string, details: unknown) =>
  new ApiError(422, 'VALIDATION', message, details);

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
// matches. Runs before any validation, so a retry still succeeds after the rules change.
async function findReplay(
  tx: Tx,
  actor: Actor,
  body: SubmitGameBody,
  payloadSha256: string,
): Promise<Game | null> {
  const [existing] = await tx
    .select({ id: games.id, payloadSha256: games.payloadSha256 })
    .from(games)
    .where(
      and(
        eq(games.leagueId, actor.leagueId),
        eq(games.submittedBy, actor.id),
        eq(games.idempotencyKey, body.idempotencyKey),
      ),
    );
  if (!existing) return null;
  if (existing.payloadSha256 !== payloadSha256) {
    throw new ApiError(
      409,
      'IDEMPOTENCY_MISMATCH',
      'A different game was already submitted with this idempotency key',
    );
  }
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
    const replay = await findReplay(tx, actor, body, payloadSha256);
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
      const raced = await findReplay(tx, actor, body, payloadSha256);
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

async function loadRevision(tx: Tx, revisionId: string): Promise<GameRevision> {
  const [revision] = await tx.select().from(gameRevisions).where(eq(gameRevisions.id, revisionId));
  if (!revision) throw new Error('referenced revision is missing');
  const players = await tx
    .select({
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
    .where(eq(revisionPlayers.revisionId, revisionId))
    // The players were inserted in request order, and UUIDv7 ids are time-ordered.
    .orderBy(asc(revisionPlayers.side), asc(revisionPlayers.id));
  return {
    id: revision.id,
    number: revision.number,
    status: revision.status,
    createdBy: revision.createdBy,
    playedAt: revision.playedAt.toISOString(),
    winner: revision.winner,
    players,
    ruleViolations: revision.ruleViolations,
    overrideStatus: revision.overrideStatus,
  };
}

async function loadGame(tx: Tx, gameId: string): Promise<Game> {
  const [game] = await tx.select().from(games).where(eq(games.id, gameId));
  if (!game) throw new Error('game is missing');
  // Parsed rather than cast: a jsonb column whose stored shape has drifted fails here,
  // loudly, instead of reaching clients.
  return Game.parse({
    id: game.id,
    kind: game.kind,
    status: game.status,
    rulesSnapshot: game.rulesSnapshot,
    windowExpiresAt: game.windowExpiresAt?.toISOString() ?? null,
    openRevision: game.openRevisionId ? await loadRevision(tx, game.openRevisionId) : null,
  });
}
