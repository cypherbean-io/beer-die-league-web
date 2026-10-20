import {
  checkRules,
  checkStructure,
  type CorrectGameBody,
  type ForceConfirmBody,
  Game,
  type GamePlayer,
  type GameRevision,
  INBOX_MAX,
  LeagueRules,
  type OverrideDecisionBody,
  type PlayerLine,
  playerLines,
  type RuleViolation,
  type Rules,
  type SeasonGameBody,
  type Side,
  type SubmitGameBody,
} from '@beer-die/core';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, max, ne } from 'drizzle-orm';
import { hit, rateLimitKey } from '../auth/rateLimit.ts';
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
  seasons,
  seasonTeams,
  teamRoster,
} from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import {
  GAME_REVISION,
  gameRevisionParams,
  OVERRIDE_REQUESTED,
  overrideRequestedParams,
} from '../mail/templates.ts';
import { recordAudit } from './audit.ts';
import { expireLapsed } from './expiry.ts';
import { type Actor, assertCommissioner } from './membership.ts';
import { settleSeason } from './seasons.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Every submission or correction mails up to three players and, when sent for review, the
// league's commissioners, so no one gets more than two mails per write (a commissioner who
// played) and this bounds the mail one member can cause. Far above what a real league night
// needs.
export const GAME_WRITES_PER_HOUR = 30;

type Deps = { db: Db; clock: Clock };

// A write that opens a revision also mails the other players a link into the app, and counts
// toward the author's write limit.
type WriteDeps = Deps & { config: { appOrigin: string; authSecret: string } };

type Path = Array<string | number>;

type GameRow = typeof games.$inferSelect;

// What every revision records, from a first submission or a correction. A season game's
// submission also names each side's team.
type ResultBody = Pick<CorrectGameBody, 'playedAt' | 'sides' | 'winner' | 'requestOverride'>;

// A result that passed checkResult, ready to store. `ids` are the players' ids in lower
// case, in playerLines order.
type CheckedResult = {
  players: PlayerLine[];
  ids: string[];
  playedAt: Date;
  winner: Side;
  ruleViolations: RuleViolation[];
};

// Where a season game's players stood: its season, the team each side played for and, in
// playerLines order, whether each player was its side's sub.
type SeasonSides = { seasonId: string; teamIds: Record<Side, string>; isSub: boolean[] };

const SIDES = ['A', 'B'] as const;

const otherSide = (side: Side): Side => (side === 'A' ? 'B' : 'A');

const invalid = (message: string, details: unknown) =>
  new ApiError(422, 'VALIDATION', message, details);

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

const windowClosed = (action: string) =>
  new ApiError(409, 'WINDOW_CLOSED', `The window to ${action} this game has closed`);

const staleRevision = (action: string) =>
  new ApiError(409, 'STALE_REVISION', `This version of the game can no longer be ${action}`);

const notAwaitingReview = () =>
  new ApiError(
    409,
    'NOT_AWAITING_REVIEW',
    'This version of the game is not waiting for a commissioner to review it',
  );

// A canonical form of everything but the idempotency key: fixed field order, lowercase ids,
// and a normalized time, so a retried draft hashes the same however its JSON was laid out.
// An exhibition game's form is the one it has always had, so a retry made across an upgrade
// still matches.
function payloadHash(body: SubmitGameBody): string {
  return sha256Hex(
    JSON.stringify([
      body.kind,
      ...(body.kind === 'season'
        ? [[body.seasonId, body.sides.A.teamId, body.sides.B.teamId].map((id) => id.toLowerCase())]
        : []),
      new Date(body.playedAt).toISOString(),
      playerLines(body.sides).map((p) => [p.side, p.membershipId.toLowerCase(), p.points, p.sinks]),
      body.winner,
      body.requestOverride ?? false,
    ]),
  );
}

// Maps a path into playerLines(body.sides) back onto the request's own shape.
function requestPath(body: ResultBody, path: Path): Path {
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

// The checks every revision passes before it is stored, in this order: the result's
// structure, the author's place among the four players, for a correction the roster, the play
// time, and the players' memberships. It also runs the rules, but leaves refusing a result
// that breaks them to refuseUnreviewed, so a season game's constraints, which no commissioner
// can override, are checked in between. `rules` is the league's for a first submission and the
// game's snapshot for a correction. `roster` is a correction's base players: a correction can
// fix the numbers and sides but not who played, or a player could swap out the others,
// leaving them unable to see or contest the game.
async function checkResult(
  tx: Tx,
  actor: Actor,
  rules: Rules,
  body: ResultBody,
  now: Date,
  roster?: ReadonlySet<string>,
): Promise<CheckedResult> {
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

  if (roster) {
    const outsiders = ids.flatMap((id, i) =>
      roster.has(id)
        ? []
        : [
            {
              code: 'NOT_IN_GAME',
              path: requestPath(body, ['players', i, 'membershipId']),
              message: 'Not a player in this game',
            },
          ],
    );
    if (outsiders.length > 0) {
      throw invalid(
        'A correction can change the numbers but not who played. Record a new game instead',
        outsiders,
      );
    }
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

  return { players, ids, playedAt, winner: body.winner, ruleViolations: checkRules(rules, result) };
}

// The last check before a revision is stored: a result that breaks the rules is refused with
// RULES_VIOLATION unless the author asks for commissioner review.
function refuseUnreviewed(body: ResultBody, result: CheckedResult): void {
  if (result.ruleViolations.length > 0 && !body.requestOverride) {
    throw new ApiError(
      422,
      'RULES_VIOLATION',
      'The result breaks the league rules. A commissioner can review it.',
      result.ruleViolations,
    );
  }
}

const beforeSeason = () =>
  invalid('A season game cannot be played before its season started', [
    {
      code: 'BEFORE_SEASON',
      path: ['playedAt'],
      message: 'Choose a time after the season started',
    },
  ]);

// The season a season game is submitted to, which must be one of the caller's league; any
// other is refused as if it didn't exist. Read before the game row is inserted, since the
// game's foreign key needs it; checkSeasonSides locks it afterwards.
async function seasonOf(tx: Tx, actor: Actor, body: SeasonGameBody): Promise<string> {
  const [season] = await tx
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.id, body.seasonId), eq(seasons.leagueId, actor.leagueId)));
  if (!season) {
    throw invalid('Choose a season of this league', [
      { code: 'UNKNOWN_SEASON', path: ['seasonId'], message: 'Not a season of this league' },
    ]);
  }
  return season.id;
}

// A first submission's season constraints (SPEC §3.7): the season is active and had started
// by the time the game was played, the sides are two different approved teams of it, and each
// side is its team's current roster but for at most one sub. A sub is any approved member who
// isn't on the side's team, except a player on the other side's team. Returns the teams and
// which players are subs, derived here and never taken from the client.
//
// The season row is held FOR SHARE until the game commits, which keeps the season from ending
// and its teams and rosters (whose writes all hold the season row) from changing meanwhile, and
// makes ending it wait to see this game open. It is taken after the game row is inserted, so
// it is never held while waiting for a game lock (see domain/seasons.ts).
async function checkSeasonSides(
  tx: Tx,
  seasonId: string,
  body: SeasonGameBody,
  result: CheckedResult,
): Promise<SeasonSides> {
  const [season] = await tx.select().from(seasons).where(eq(seasons.id, seasonId)).for('share');
  if (!season) throw new Error('season of a season game is missing');
  if (season.status !== 'active' || !season.startedAt) {
    throw new ApiError(
      409,
      'SEASON_NOT_ACTIVE',
      'Season games can be recorded only while the season is active',
    );
  }
  if (result.playedAt.getTime() < season.startedAt.getTime()) throw beforeSeason();

  // Ids are matched case-insensitively; Postgres returns them in lower case.
  const teamIds = { A: body.sides.A.teamId.toLowerCase(), B: body.sides.B.teamId.toLowerCase() };
  if (teamIds.A === teamIds.B) {
    throw invalid('The two sides must be different teams', [
      {
        code: 'SAME_TEAM',
        path: ['sides', 'B', 'teamId'],
        message: "Choose a team other than side A's",
      },
    ]);
  }
  // A team that isn't approved is refused like an unknown one, since only its pair and the
  // commissioners may know of it.
  const approvedTeams = await tx
    .select({ id: seasonTeams.id })
    .from(seasonTeams)
    .where(
      and(
        eq(seasonTeams.seasonId, season.id),
        inArray(seasonTeams.id, [teamIds.A, teamIds.B]),
        eq(seasonTeams.status, 'approved'),
      ),
    );
  const unapproved = SIDES.filter((side) => !approvedTeams.some((t) => t.id === teamIds[side]));
  if (unapproved.length > 0) {
    throw invalid(
      'Both sides must be approved teams in this season',
      unapproved.map((side) => ({
        code: 'NOT_APPROVED_TEAM',
        path: ['sides', side, 'teamId'],
        message: 'Not an approved team in this season',
      })),
    );
  }

  // An approved team's players are its open roster rows (see domain/teams.ts).
  const roster = await tx
    .select({ teamId: teamRoster.teamId, membershipId: teamRoster.membershipId })
    .from(teamRoster)
    .where(and(inArray(teamRoster.teamId, [teamIds.A, teamIds.B]), isNull(teamRoster.validTo)));
  const onTeamOf = (side: Side, id: string) =>
    roster.some((r) => r.teamId === teamIds[side] && r.membershipId === id);
  const isSub = result.players.map((p, i) => !onTeamOf(p.side, result.ids[i]!));
  const problems = [
    ...result.players.flatMap((p, i) =>
      onTeamOf(otherSide(p.side), result.ids[i]!)
        ? [
            {
              code: 'OPPOSING_PLAYER',
              path: requestPath(body, ['players', i, 'membershipId']),
              message: "On the other side's team",
            },
          ]
        : [],
    ),
    ...SIDES.flatMap((side) =>
      result.players.filter((p, i) => p.side === side && isSub[i]).length > 1
        ? [
            {
              code: 'TOO_MANY_SUBS',
              path: ['sides', side, 'players'],
              message: 'A side can have at most one sub',
            },
          ]
        : [],
    ),
  ];
  if (problems.length > 0) {
    throw invalid("Each side must be its team's players, with at most one sub", problems);
  }
  return { seasonId: season.id, teamIds, isSub };
}

// A correction of a season game keeps its teams: each side of the result must be one of the
// base revision's sides, whole, so the team each side played for and its sub come along with
// its players. A roster change since then never moves a recorded game to another team, nor
// reruns the sub rule on it. The play time must still fall on or after the season's start.
async function carrySeasonSides(
  tx: Tx,
  game: GameRow,
  baseId: string,
  body: ResultBody,
  result: CheckedResult,
): Promise<SeasonSides> {
  if (!game.seasonId) throw new Error('season game has no season');
  const [base] = await tx
    .select({ A: gameRevisions.sideATeamId, B: gameRevisions.sideBTeamId })
    .from(gameRevisions)
    .where(eq(gameRevisions.id, baseId));
  if (!base?.A || !base.B) throw new Error('season game revision has no teams');
  const seats = await tx
    .select({
      membershipId: revisionPlayers.membershipId,
      side: revisionPlayers.side,
      isSub: revisionPlayers.isSub,
    })
    .from(revisionPlayers)
    .where(eq(revisionPlayers.revisionId, baseId));
  // checkResult has already held the result to the base revision's players.
  const seatOf = (id: string) => {
    const seat = seats.find((s) => s.membershipId === id);
    if (!seat) throw new Error('corrected player is missing from the base revision');
    return seat;
  };

  // Either every player keeps their side or every player swaps.
  const moved = result.ids.map((id, i) => seatOf(id).side !== result.players[i]!.side);
  const swapped = moved.every(Boolean);
  if (!swapped && moved.some(Boolean)) {
    throw invalid(
      "A correction can't move players between teams. Record a new game instead",
      moved.flatMap((m, i) =>
        m
          ? [
              {
                code: 'TEAM_CHANGED',
                path: requestPath(body, ['players', i, 'membershipId']),
                message: 'Played for the other team in this game',
              },
            ]
          : [],
      ),
    );
  }

  // A season's start never changes once set, so this needs no lock.
  const [season] = await tx
    .select({ startedAt: seasons.startedAt })
    .from(seasons)
    .where(eq(seasons.id, game.seasonId));
  if (!season?.startedAt) throw new Error('season of a season game never started');
  if (result.playedAt.getTime() < season.startedAt.getTime()) throw beforeSeason();

  return {
    seasonId: game.seasonId,
    teamIds: swapped ? { A: base.B, B: base.A } : { A: base.A, B: base.B },
    isSub: result.ids.map((id) => seatOf(id).isSub),
  };
}

// Counted outside the transaction, so a refused attempt still counts.
async function limitGameWrites(deps: WriteDeps, actor: Actor, now: Date): Promise<void> {
  const key = rateLimitKey(deps.config.authSecret, 'game-write', actor.id);
  if (!(await hit(deps.db, key, GAME_WRITES_PER_HOUR, HOUR_MS, now))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many games recorded. Try again later.');
  }
}

// Stores a checked result as the game's open revision, with the author's confirmation:
// recording a result counts as confirming it. A result that breaks the rules awaits a
// commissioner's review; nothing carries over from an earlier revision. A season game's
// revision records its teams and subs from `sides`; an exhibition game has no teams, so nobody
// in it is a sub. The other players are told by email, and so, for a review, are the
// commissioners.
async function openRevision(
  tx: Tx,
  actor: Actor,
  gameId: string,
  number: number,
  result: CheckedResult,
  sides: SeasonSides | null,
  now: Date,
  appOrigin: string,
): Promise<void> {
  const [revision] = await tx
    .insert(gameRevisions)
    .values({
      gameId,
      number,
      status: 'open',
      createdBy: actor.id,
      playedAt: result.playedAt,
      seasonId: sides?.seasonId ?? null,
      sideATeamId: sides?.teamIds.A ?? null,
      sideBTeamId: sides?.teamIds.B ?? null,
      winner: result.winner,
      ruleViolations: result.ruleViolations,
      overrideStatus: result.ruleViolations.length > 0 ? 'requested' : null,
      createdAt: now,
    })
    .returning({ id: gameRevisions.id });
  if (!revision) throw new Error('insert returned no revision');

  await tx.insert(revisionPlayers).values(
    result.players.map((p, i) => ({
      revisionId: revision.id,
      side: p.side,
      membershipId: result.ids[i]!,
      isSub: sides?.isSub[i] ?? false,
      points: p.points,
      sinks: p.sinks,
    })),
  );
  await tx.insert(confirmations).values({
    revisionId: revision.id,
    membershipId: actor.id,
    kind: 'player',
    createdAt: now,
  });
  await tx.update(games).set({ openRevisionId: revision.id }).where(eq(games.id, gameId));
  // Revision 1 is the submission; every later one is a correction.
  await mailOtherPlayers(tx, actor, result.ids, number === 1 ? 'submitted' : 'corrected', {
    appOrigin,
    now,
  });
  if (result.ruleViolations.length > 0) await mailCommissioners(tx, actor, { appOrigin, now });
}

// Queues a note for each of the revision's other players who takes email (SPEC §3.9): the
// author's name and a link to the inbox, never the scores. It is enqueued in the write's
// transaction, so a write that fails or rolls back mails no one.
async function mailOtherPlayers(
  tx: Tx,
  actor: Actor,
  ids: string[],
  action: 'submitted' | 'corrected',
  { appOrigin, now }: { appOrigin: string; now: Date },
): Promise<void> {
  const seats = await tx
    .select({
      id: memberships.id,
      userId: memberships.userId,
      displayName: memberships.displayName,
      emailNotifications: memberships.emailNotifications,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.leagueId, actor.leagueId),
        inArray(memberships.id, ids),
        eq(memberships.status, 'approved'),
      ),
    );
  const author = seats.find((s) => s.id === actor.id);
  if (!author) throw new Error('author of a checked result is missing');
  const params = gameRevisionParams(author.displayName, action, `${appOrigin}/inbox`);
  for (const seat of seats) {
    if (seat.id === actor.id || !seat.emailNotifications) continue;
    await enqueueEmail(tx, { userId: seat.userId, template: GAME_REVISION, params, now });
  }
}

// Queues a review request for each commissioner who takes email (SPEC §3.5), except the
// author, who asked for it: the author's name and a link into the app, never the scores or
// the rules broken. Like mailOtherPlayers, it is enqueued in the write's transaction.
async function mailCommissioners(
  tx: Tx,
  actor: Actor,
  { appOrigin, now }: { appOrigin: string; now: Date },
): Promise<void> {
  const [author] = await tx
    .select({ displayName: memberships.displayName })
    .from(memberships)
    .where(and(eq(memberships.id, actor.id), eq(memberships.leagueId, actor.leagueId)));
  if (!author) throw new Error('author of a checked result is missing');
  const commissioners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.leagueId, actor.leagueId),
        eq(memberships.role, 'commissioner'),
        eq(memberships.status, 'approved'),
        eq(memberships.emailNotifications, true),
        ne(memberships.id, actor.id),
      ),
    );
  const params = overrideRequestedParams(author.displayName, `${appOrigin}/`);
  for (const { userId } of commissioners) {
    await enqueueEmail(tx, { userId, template: OVERRIDE_REQUESTED, params, now });
  }
}

// Records the first submission of a game: revision 1, open, with the submitter's
// confirmation. `leagueId` always comes from the actor's membership. A season game must also
// meet its season's constraints (checkSeasonSides), checked once its row is inserted.
export async function submitGame(
  deps: WriteDeps,
  actor: Actor,
  body: SubmitGameBody,
): Promise<{ game: Game; created: boolean }> {
  const now = deps.clock.now();
  await limitGameWrites(deps, actor, now);
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
    const result = await checkResult(tx, actor, rules, body, now);
    const seasonId = body.kind === 'season' ? await seasonOf(tx, actor, body) : null;

    // A concurrent submission of the same key makes this insert wait for it to commit, then
    // insert nothing; that submission's game is then the replay. Neither holds the season
    // lock yet, so locking that game for the replay keeps the lock order.
    const [game] = await tx
      .insert(games)
      .values({
        leagueId: actor.leagueId,
        kind: body.kind,
        seasonId,
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

    const sides =
      body.kind === 'season' ? await checkSeasonSides(tx, seasonId!, body, result) : null;
    refuseUnreviewed(body, result);
    await openRevision(tx, actor, game.id, 1, result, sides, now, deps.config.appOrigin);
    return { game: await loadGame(tx, game.id), created: true };
  });
}

// A player of the game corrects its open revision, or, when nothing is open, its confirmed
// revision, which reopens the game (SPEC §3.5). Either way the result is for the same four
// players, is checked against the game's rules snapshot, and starts with only the author's
// confirmation, so the other players confirm again. A season game keeps its teams and subs
// (carrySeasonSides). A correction of the open revision supersedes it and keeps the window
// running. A reopening starts a new window and leaves the confirmed revision counting until
// its correction confirms.
export async function correctGame(
  deps: WriteDeps,
  actor: Actor,
  gameId: string,
  body: CorrectGameBody,
): Promise<Game> {
  const now = deps.clock.now();
  await limitGameWrites(deps, actor, now);
  // Ids are matched case-insensitively; Postgres returns them in lower case.
  const baseId = body.baseRevisionId.toLowerCase();

  return deps.db.transaction(async (tx) => {
    const game = await lockGame(tx, actor, gameId, now);
    const [base] = await tx
      .select({ status: gameRevisions.status })
      .from(gameRevisions)
      .where(and(eq(gameRevisions.id, baseId), eq(gameRevisions.gameId, game.id)));
    if (!base) throw staleRevision('corrected');

    const seats = await tx
      .select({ membershipId: revisionPlayers.membershipId })
      .from(revisionPlayers)
      .where(eq(revisionPlayers.revisionId, baseId));
    const roster = new Set(seats.map((s) => s.membershipId));
    if (!roster.has(actor.id)) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the players in a game can correct it');
    }
    // A rejected revision stays the open one until a correction supersedes it, so one that
    // no longer is had its window close.
    if (
      base.status === 'expired' ||
      (base.status === 'rejected' && game.openRevisionId !== baseId)
    ) {
      throw windowClosed('correct');
    }
    const reopening = game.openRevisionId === null && game.confirmedRevisionId === baseId;
    if (!reopening && game.openRevisionId !== baseId) throw staleRevision('corrected');
    if (reopening) await reopenGame(tx, actor, game, now);

    const rules = LeagueRules.parse(game.rulesSnapshot);
    const result = await checkResult(tx, actor, rules, body, now, roster);
    const sides =
      game.kind === 'season' ? await carrySeasonSides(tx, game, baseId, body, result) : null;
    refuseUnreviewed(body, result);
    const [latest] = await tx
      .select({ number: max(gameRevisions.number) })
      .from(gameRevisions)
      .where(eq(gameRevisions.gameId, game.id));
    if (!latest?.number) throw new Error('game has no revisions');

    // A confirmed base keeps counting; settleRevision supersedes it once its correction
    // confirms.
    if (!reopening) {
      await tx
        .update(gameRevisions)
        .set({ status: 'superseded' })
        .where(eq(gameRevisions.id, baseId));
    }
    await openRevision(
      tx,
      actor,
      game.id,
      latest.number + 1,
      result,
      sides,
      now,
      deps.config.appOrigin,
    );
    return loadGame(tx, game.id);
  });
}

// Opens a new window on a confirmed game, from the league's current setting. An exhibition
// game reopens only while `now < confirmed_at + exhibition_correction_window_days`, both as
// they stand now; a season game only while its season is active (SPEC §3.5). The season row is
// then held FOR SHARE until the correction commits, so the season can't end without seeing the
// game open. The game lock is already held, which keeps the lock order game → season, and
// nothing later in the correction takes the season lock any harder.
async function reopenGame(tx: Tx, actor: Actor, game: GameRow, now: Date): Promise<void> {
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, actor.leagueId));
  if (!league) throw new Error('league of a resolved membership is missing');
  if (!game.confirmedAt) throw new Error('confirmed game has no confirmation time');
  if (game.kind === 'season') {
    if (!game.seasonId) throw new Error('season game has no season');
    const [season] = await tx
      .select({ status: seasons.status })
      .from(seasons)
      .where(eq(seasons.id, game.seasonId))
      .for('share');
    if (season?.status !== 'active') throw windowClosed('reopen');
  } else {
    const closesAt = game.confirmedAt.getTime() + league.exhibitionCorrectionWindowDays * DAY_MS;
    if (now.getTime() >= closesAt) throw windowClosed('reopen');
  }
  await tx
    .update(games)
    .set({ windowExpiresAt: new Date(now.getTime() + league.confirmationWindowDays * DAY_MS) })
    .where(eq(games.id, game.id));
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

// A commissioner action's second role check, made under the game lock. The role was read
// before the lock wait; FOR SHARE re-reads it as committed since, and holds it until this
// commits.
async function recheckCommissioner(tx: Tx, actor: Actor): Promise<void> {
  const [self] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')))
    .for('share');
  assertCommissioner({ ...actor, role: self?.role ?? 'member' });
}

// Materializes a lapsed window (expireLapsed) under the game row lock, before a write does
// anything else. A season game's ended season then finalizes if nothing else in it is open.
async function settleExpired(tx: Tx, game: GameRow, now: Date): Promise<GameRow> {
  const settled = await expireLapsed(tx, game, now);
  if (settled !== game && settled.seasonId) await settleSeason(tx, settled.seasonId, now);
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
// stats read, superseding the one a reopened game counted until now. `confirmed_at` records
// only the first time the game counts. A season game's ended season then finalizes if nothing
// else in it is open. Call it under the game row lock after any change that could complete the
// open revision. Until then it changes nothing.
async function settleRevision(tx: Tx, game: GameRow, now: Date): Promise<void> {
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
  if (game.confirmedRevisionId) {
    await tx
      .update(gameRevisions)
      .set({ status: 'superseded' })
      .where(eq(gameRevisions.id, game.confirmedRevisionId));
  }
  await tx
    .update(games)
    .set({
      status: 'confirmed',
      confirmedRevisionId: revisionId,
      confirmedAt: game.confirmedAt ?? now,
      openRevisionId: null,
      windowExpiresAt: null,
    })
    .where(eq(games.id, game.id));
  if (game.seasonId) await settleSeason(tx, game.seasonId, now);
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

    if (revision.status === 'expired') throw windowClosed('confirm');
    if (revision.status !== 'open' || game.openRevisionId !== rid) {
      throw staleRevision('confirmed');
    }

    await tx.insert(confirmations).values({
      revisionId: rid,
      membershipId: actor.id,
      kind: 'player',
      createdAt: now,
    });
    await settleRevision(tx, game, now);
    return loadGame(tx, game.id);
  });
}

// A commissioner confirms the revision they were shown for listed players who have stayed
// silent (SPEC §3.5). Each forced confirmation is audited, flagged when the commissioner played
// in the game, and the revision then confirms like any other once all four have one. A listed
// player who has already confirmed is skipped, so if none is left the game comes back
// unchanged, whatever has happened to it since. A player who disagrees can still correct the
// result, which starts the confirmations over.
export async function forceConfirm(
  deps: Deps,
  actor: Actor,
  gameId: string,
  revisionId: string,
  body: ForceConfirmBody,
): Promise<Game> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  // Ids are matched case-insensitively; Postgres returns them in lower case.
  const rid = revisionId.toLowerCase();
  const listed = body.membershipIds.map((id) => id.toLowerCase());

  return deps.db.transaction(async (tx) => {
    const game = await lockGame(tx, actor, gameId, now);
    await recheckCommissioner(tx, actor);

    const [revision] = await tx
      .select({ status: gameRevisions.status })
      .from(gameRevisions)
      .where(and(eq(gameRevisions.id, rid), eq(gameRevisions.gameId, game.id)));
    if (!revision) throw notFound();

    const seats = await tx
      .select({ membershipId: revisionPlayers.membershipId, confirmation: confirmations.id })
      .from(revisionPlayers)
      .leftJoin(
        confirmations,
        and(
          eq(confirmations.revisionId, revisionPlayers.revisionId),
          eq(confirmations.membershipId, revisionPlayers.membershipId),
        ),
      )
      .where(eq(revisionPlayers.revisionId, rid));
    const hasConfirmed = new Map(seats.map((s) => [s.membershipId, s.confirmation !== null]));
    const outsiders = listed.flatMap((id, i) =>
      hasConfirmed.has(id)
        ? []
        : [
            {
              code: 'NOT_IN_GAME',
              path: ['membershipIds', i],
              message: 'Not a player in this game',
            },
          ],
    );
    if (outsiders.length > 0) {
      throw invalid('Only the players in this game can be confirmed', outsiders);
    }
    // A forced confirmation says the player stayed silent, which a commissioner who played
    // and is right here did not.
    const own = listed.indexOf(actor.id);
    if (own !== -1) {
      throw invalid('A commissioner confirms their own result like any other player', [
        { code: 'SELF', path: ['membershipIds', own], message: 'Confirm your own result instead' },
      ]);
    }

    const silent = listed.filter((id) => !hasConfirmed.get(id));
    if (silent.length === 0) return loadGame(tx, game.id);
    if (revision.status === 'expired') throw windowClosed('confirm');
    if (revision.status !== 'open' || game.openRevisionId !== rid) {
      throw staleRevision('confirmed');
    }

    await tx.insert(confirmations).values(
      silent.map((membershipId) => ({
        revisionId: rid,
        membershipId,
        kind: 'forced' as const,
        forcedBy: actor.id,
        createdAt: now,
      })),
    );
    const actorWasParticipant = hasConfirmed.has(actor.id);
    for (const membershipId of silent) {
      await recordAudit(
        tx,
        actor,
        {
          action: 'game.confirmation_forced',
          targetType: 'game',
          targetId: game.id,
          actorWasParticipant,
          details: { revisionId: rid, membershipId },
        },
        now,
      );
    }
    await settleRevision(tx, game, now);
    return loadGame(tx, game.id);
  });
}

// A commissioner decides the review of the rule-breaking revision they were shown (SPEC §3.5).
// Approving lets it confirm once all four players have, in either order; rejecting means it
// never counts, though its players can still correct it while the window runs. The decision
// is audited, flagged when the commissioner played in the game, and final: repeating it
// returns the game unchanged, whatever has happened to it since, and the other decision is
// refused.
export async function decideOverride(
  deps: Deps,
  actor: Actor,
  gameId: string,
  revisionId: string,
  body: OverrideDecisionBody,
): Promise<Game> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  // Path ids are matched case-insensitively; Postgres returns them in lower case.
  const rid = revisionId.toLowerCase();
  const outcome = body.decision === 'approve' ? 'approved' : 'rejected';

  return deps.db.transaction(async (tx) => {
    const game = await lockGame(tx, actor, gameId, now);
    await recheckCommissioner(tx, actor);

    const [revision] = await tx
      .select({ status: gameRevisions.status, overrideStatus: gameRevisions.overrideStatus })
      .from(gameRevisions)
      .where(and(eq(gameRevisions.id, rid), eq(gameRevisions.gameId, game.id)));
    if (!revision) throw notFound();
    if (revision.overrideStatus === outcome) return loadGame(tx, game.id);
    if (revision.status === 'expired') throw windowClosed('review');
    if (revision.overrideStatus !== 'requested') throw notAwaitingReview();
    if (revision.status !== 'open' || game.openRevisionId !== rid) {
      throw staleRevision('reviewed');
    }

    await tx
      .update(gameRevisions)
      .set({
        overrideStatus: outcome,
        overrideBy: actor.id,
        ...(outcome === 'rejected' && { status: 'rejected' as const }),
      })
      .where(eq(gameRevisions.id, rid));
    const [seat] = await tx
      .select({ id: revisionPlayers.id })
      .from(revisionPlayers)
      .where(and(eq(revisionPlayers.revisionId, rid), eq(revisionPlayers.membershipId, actor.id)));
    await recordAudit(
      tx,
      actor,
      {
        action: 'game.override_decided',
        targetType: 'game',
        targetId: game.id,
        actorWasParticipant: seat !== undefined,
        details: { revisionId: rid, decision: body.decision },
      },
      now,
    );
    if (outcome === 'approved') await settleRevision(tx, game, now);
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

  // A season game's revisions name their teams, all approved, so any member may see them.
  const teamIds = [
    ...new Set(
      revisions.flatMap((r) => [r.sideATeamId, r.sideBTeamId].filter((id) => id !== null)),
    ),
  ];
  const teamNames = new Map(
    teamIds.length === 0
      ? []
      : (
          await tx
            .select({ id: seasonTeams.id, name: seasonTeams.name })
            .from(seasonTeams)
            .where(inArray(seasonTeams.id, teamIds))
        ).map((t) => [t.id, t.name]),
  );
  const team = (id: string) => {
    const name = teamNames.get(id);
    if (name === undefined) throw new Error('team of a revision is missing');
    return { id, name };
  };

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
        teams:
          revision.sideATeamId && revision.sideBTeamId
            ? { A: team(revision.sideATeamId), B: team(revision.sideBTeamId) }
            : null,
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
      seasonId: game.seasonId,
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
