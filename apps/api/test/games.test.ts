import { randomUUID } from 'node:crypto';
import {
  AuditResponse,
  type CorrectGameBody,
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  INBOX_MAX,
  InboxResponse,
  JoinResponse,
  type ExhibitionGameBody,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { GAME_WRITES_PER_HOUR, sweepExpired } from '../src/domain/games.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const NOW = '2026-10-18T12:00:00.000Z';
const DEFAULT_RULES = { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false };

type SentMail = { to: Array<{ address: string }>; subject: string; text: string };

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;
let call: ReturnType<typeof client>;
let sent: SentMail[];

const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
const capturingTransport: MailTransport = {
  async sendMail(message) {
    const info = await jsonTransport.sendMail(message);
    sent.push(JSON.parse(info.message) as SentMail);
    return info;
  },
};

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  clock = new FixedClock(NOW);
  sent = [];
  api = await startApi(database.url, { clock });
  call = client(api.baseUrl);
  await resetTables(api.db);
});

afterEach(async () => {
  await api.stop();
});

async function errorOf(res: Response) {
  return ErrorBody.parse(await res.json()).error;
}

function drain() {
  return drainOutbox({
    db: api.db,
    clock,
    transport: capturingTransport,
    mailFrom: 'Beer Die League <league@app.test>',
    authSecret: api.authSecret,
    log: (entry) => api.logs.push(entry),
  });
}

type Player = { caller: Caller; membershipId: string };
type League = { leagueId: string; commissioner: Caller };
// Ana is the commissioner; Bo, Cy, and Di are approved members.
type Table = League & { ana: Player; bo: Player; cy: Player; di: Player };

async function league(name: string, email: string, displayName: string) {
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName,
  });
  const caller = await signIn(api.db, clock, email);
  return { leagueId, commissioner: caller, self: { caller, membershipId } };
}

// A signed-in member admitted through the real invite flow, approved unless told otherwise.
async function member(l: League, email: string, displayName: string, approve = true) {
  const caller = await signIn(api.db, clock, email);
  const created = await call('POST', `/api/leagues/${l.leagueId}/invites`, {
    as: l.commissioner,
    body: {},
  });
  const { url } = CreateInviteResponse.parse(await created.json());
  const token = url.slice(`${APP_ORIGIN}/join/`.length);
  const joined = await call('POST', `/api/invites/${token}/join`, {
    as: caller,
    body: { displayName },
  });
  const membershipId = JoinResponse.parse(await joined.json()).membership.id;
  if (approve) {
    const approved = await call(
      'POST',
      `/api/leagues/${l.leagueId}/members/${membershipId}/approve`,
      { as: l.commissioner, body: {} },
    );
    expect(approved.status).toBe(200);
  }
  return { caller, membershipId };
}

async function table(): Promise<Table> {
  const { self: ana, ...l } = await league('Basement League', 'ana@example.com', 'Ana');
  return {
    ...l,
    ana,
    bo: await member(l, 'bo@example.com', 'Bo'),
    cy: await member(l, 'cy@example.com', 'Cy'),
    di: await member(l, 'di@example.com', 'Di'),
  };
}

const line = (p: Player | string, points: number, sinks = 0) => ({
  membershipId: typeof p === 'string' ? p : p.membershipId,
  points,
  sinks,
});

// Ana and Bo beat Cy and Di 11–9, half an hour ago.
function game(t: Table, patch: Partial<ExhibitionGameBody> = {}): ExhibitionGameBody {
  return {
    idempotencyKey: randomUUID(),
    kind: 'exhibition',
    playedAt: '2026-10-18T11:30:00.000Z',
    sides: {
      A: { players: [line(t.ana, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 4)] },
    },
    winner: 'A',
    ...patch,
  };
}

// Ana and Bo win 11–10, one point short of the default win-by.
function marginTooSmall(t: Table, patch: Partial<ExhibitionGameBody> = {}): ExhibitionGameBody {
  return game(t, {
    sides: {
      A: { players: [line(t.ana, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 5)] },
    },
    ...patch,
  });
}

function submit(t: League, as: Caller, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${t.leagueId}/games`, { as, body });
}

async function submitted(t: League, as: Caller, body: unknown): Promise<Game> {
  const res = await submit(t, as, body);
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

type TableName =
  | 'games'
  | 'game_revisions'
  | 'revision_players'
  | 'confirmations'
  | 'audit_events'
  | 'email_outbox'
  | 'counted_results';

async function rows(table: TableName) {
  const [row] = await api.db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return row!.n;
}

function patchLeague(t: League, what: 'rules' | 'settings', body: unknown) {
  return call('PATCH', `/api/leagues/${t.leagueId}/${what}`, { as: t.commissioner, body });
}

function confirm(
  t: League,
  as: Caller,
  gameId: string,
  revisionId: string,
  body: unknown = {},
): Promise<Response> {
  return call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${gameId}/revisions/${revisionId}/confirm`,
    { as, body },
  );
}

// Confirms the game's open revision as shown in `g`.
async function confirmed(t: League, as: Caller, g: Game): Promise<Game> {
  const res = await confirm(t, as, g.id, g.openRevision!.id);
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

// A correction of the revision shown in `g`, its open one or else its confirmed one (which
// reopens the game): the default game with Di's 4 points fixed to 3, so Ana and Bo beat Cy
// and Di 11–8.
function correction(t: Table, g: Game, patch: Partial<CorrectGameBody> = {}): CorrectGameBody {
  return {
    baseRevisionId: (g.openRevision ?? g.confirmedRevision)!.id,
    playedAt: '2026-10-18T11:30:00.000Z',
    sides: {
      A: { players: [line(t.ana, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 3)] },
    },
    winner: 'A',
    ...patch,
  };
}

function correct(t: League, as: Caller, gameId: string, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${t.leagueId}/games/${gameId}/revisions`, { as, body });
}

async function corrected(t: League, as: Caller, gameId: string, body: unknown): Promise<Game> {
  const res = await correct(t, as, gameId, body);
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

function forceConfirm(
  t: League,
  as: Caller,
  gameId: string,
  revisionId: string,
  body: unknown,
): Promise<Response> {
  return call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${gameId}/revisions/${revisionId}/force-confirm`,
    { as, body },
  );
}

// The commissioner confirms the open revision shown in `g` for `players`.
async function forced(t: League, g: Game, players: Player[]): Promise<Game> {
  const res = await forceConfirm(t, t.commissioner, g.id, g.openRevision!.id, {
    membershipIds: players.map((p) => p.membershipId),
  });
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

function override(
  t: League,
  as: Caller,
  gameId: string,
  revisionId: string,
  body: unknown,
): Promise<Response> {
  return call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${gameId}/revisions/${revisionId}/override`,
    { as, body },
  );
}

// The commissioner decides the review of the open revision shown in `g`.
async function decided(t: League, g: Game, decision: 'approve' | 'reject'): Promise<Game> {
  const res = await override(t, t.commissioner, g.id, g.openRevision!.id, { decision });
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

async function auditLog(t: League, as: Caller) {
  const res = await call('GET', `/api/leagues/${t.leagueId}/audit`, { as });
  expect(res.status).toBe(200);
  return AuditResponse.parse(await res.json()).events;
}

async function inbox(t: League, as: Caller): Promise<Game[]> {
  const res = await call('GET', `/api/leagues/${t.leagueId}/inbox`, { as });
  expect(res.status).toBe(200);
  return InboxResponse.parse(await res.json()).games;
}

// The revision stats read for this game, or null while it counts for nothing.
async function countedRevision(gameId: string): Promise<string | null> {
  const [row] = await api.db.execute<{ id: string | null }>(
    sql`select confirmed_revision_id as id from games where id = ${gameId}`,
  );
  return row!.id;
}

async function storedStatus(gameId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from games where id = ${gameId}`,
  );
  return row!.status;
}

async function revisionStatus(revisionId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from game_revisions where id = ${revisionId}`,
  );
  return row!.status;
}

const confirmationsOf = (g: Game) =>
  (g.openRevision ?? g.confirmedRevision)!.players.map((p) => p.confirmation);

// Holds the game's row lock until `n` requests are queued behind it, so they run back to
// back against the same state.
async function queuedOn(
  gameId: string,
  requests: () => Array<Promise<Response>>,
): Promise<Response[]> {
  let racing: Promise<Response[]> | undefined;
  await api.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from games where id = ${gameId} for update`);
    const started = requests();
    racing = Promise.all(started);
    await waitForLockWaiters(api.db, started.length);
  });
  return racing!;
}

// queuedOn for requests that all succeed with a game.
async function raceOn(gameId: string, requests: () => Array<Promise<Response>>) {
  const responses = await queuedOn(gameId, requests);
  return Promise.all(
    responses.map(async (r) => ({
      status: r.status,
      game: GameResponse.parse(await r.json()).game,
    })),
  );
}

describe('submitting an exhibition game', () => {
  it("opens revision 1 with the four player lines and the submitter's confirmation", async () => {
    const t = await table();

    const recorded = await submitted(t, t.ana.caller, game(t));

    expect(recorded).toEqual({
      id: expect.any(String),
      kind: 'exhibition',
      seasonId: null,
      status: 'pending',
      windowExpiresAt: '2026-10-25T12:00:00.000Z',
      rulesSnapshot: DEFAULT_RULES,
      openRevision: {
        id: expect.any(String),
        number: 1,
        status: 'open',
        createdBy: t.ana.membershipId,
        playedAt: '2026-10-18T11:30:00.000Z',
        winner: 'A',
        ruleViolations: [],
        overrideStatus: null,
        teams: null,
        players: [
          {
            membershipId: t.ana.membershipId,
            displayName: 'Ana',
            side: 'A',
            points: 6,
            sinks: 0,
            isSub: false,
            confirmation: 'player',
          },
          {
            membershipId: t.bo.membershipId,
            displayName: 'Bo',
            side: 'A',
            points: 5,
            sinks: 0,
            isSub: false,
            confirmation: null,
          },
          {
            membershipId: t.cy.membershipId,
            displayName: 'Cy',
            side: 'B',
            points: 5,
            sinks: 0,
            isSub: false,
            confirmation: null,
          },
          {
            membershipId: t.di.membershipId,
            displayName: 'Di',
            side: 'B',
            points: 4,
            sinks: 0,
            isSub: false,
            confirmation: null,
          },
        ],
      },
      confirmedRevision: null,
    });
    expect(await rows('games')).toBe(1);
    expect(await rows('confirmations')).toBe(1);
  });

  it('records the confirmation of whichever player submits, on either side', async () => {
    const t = await table();

    const recorded = await submitted(t, t.di.caller, game(t));

    const confirmed = recorded.openRevision!.players.filter((p) => p.confirmation !== null);
    expect(confirmed).toEqual([
      expect.objectContaining({ membershipId: t.di.membershipId, confirmation: 'player' }),
    ]);
    expect(recorded.openRevision!.createdBy).toBe(t.di.membershipId);
  });

  it("starts the confirmation window from the league's setting at submission", async () => {
    const t = await table();
    expect((await patchLeague(t, 'settings', { confirmationWindowDays: 3 })).status).toBe(200);
    clock.advance(10 * SECOND);

    const recorded = await submitted(t, t.ana.caller, game(t));

    expect(recorded.windowExpiresAt).toBe(
      new Date(Date.parse(NOW) + 10 * SECOND + 3 * DAY).toISOString(),
    );
  });

  it('snapshots the league rules at submission and checks the game against them', async () => {
    const t = await table();
    const rules = { targetScore: 7, winBy: 1, sinkPoints: 3, sinkEndsGame: false };
    expect((await patchLeague(t, 'rules', rules)).status).toBe(200);

    // 7–6 with a 3-point sink: legal only under the edited rules.
    const recorded = await submitted(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 4, 1), line(t.bo, 3)] },
          B: { players: [line(t.cy, 3), line(t.di, 3)] },
        },
      }),
    );

    expect(recorded.rulesSnapshot).toEqual(rules);
    expect(recorded.openRevision!.ruleViolations).toEqual([]);
  });

  it('accepts a game played at exactly the current time', async () => {
    const t = await table();

    const recorded = await submitted(t, t.ana.caller, game(t, { playedAt: NOW }));

    expect(recorded.openRevision!.playedAt).toBe(NOW);
  });
});

describe('who may submit, and with whom', () => {
  it('refuses a submitter who is not one of the four players with 403, even a commissioner', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');

    const res = await submit(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(ed, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 4)] },
        },
      }),
    );

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('games')).toBe(0);
  });

  it.each([
    ['a member awaiting approval', (t: Table) => member(t, 'ed@example.com', 'Ed', false)],
    [
      'a member of another league',
      async () => (await league('Garage League', 'yan@example.com', 'Yan')).self,
    ],
    ['an id that names no member', async () => randomUUID()],
  ])('rejects %s as a player with 422 VALIDATION', async (_label, make) => {
    const t = await table();
    const other = await make(t);

    const res = await submit(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(other, 4)] },
        },
      }),
    );

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ path: ['sides', 'B', 'players', 1, 'membershipId'] }],
    });
    expect(await rows('games')).toBe(0);
  });
});

describe('validation', () => {
  it('rejects a game played in the future with 422 VALIDATION', async () => {
    const t = await table();

    const res = await submit(t, t.ana.caller, game(t, { playedAt: '2026-10-18T12:00:01.000Z' }));

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ path: ['playedAt'] }],
    });
    expect(await rows('games')).toBe(0);
  });

  // Postgres keeps these, but reading them back through `new Date()` misparses the year
  // (0049 becomes 2049) or fails, so they never reach the database.
  it.each(['0049-10-18T11:30:00.000Z', '0030-10-18T11:30:00.000Z', '0000-01-01T00:00:00.000Z'])(
    'rejects the far-past playedAt %s with 422 VALIDATION',
    async (playedAt) => {
      const t = await table();

      const res = await submit(t, t.ana.caller, game(t, { playedAt }));

      expect(res.status).toBe(422);
      expect(await errorOf(res)).toMatchObject({
        code: 'VALIDATION',
        details: [{ path: ['playedAt'] }],
      });
      expect(await rows('games')).toBe(0);
    },
  );

  it('rejects a player listed twice, naming the repeated entry', async () => {
    const t = await table();

    const res = await submit(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.bo, 4)] },
        },
      }),
    );

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ code: 'DUPLICATE_PLAYER', path: ['sides', 'B', 'players', 1, 'membershipId'] }],
    });
    expect(await rows('games')).toBe(0);
  });

  it('rejects points that leave out the sink points, which no override can allow', async () => {
    const t = await table();
    expect((await patchLeague(t, 'rules', { sinkPoints: 3 })).status).toBe(200);

    const res = await submit(
      t,
      t.ana.caller,
      game(t, {
        requestOverride: true,
        sides: {
          A: { players: [line(t.ana, 2, 1), line(t.bo, 9)] },
          B: { players: [line(t.cy, 5), line(t.di, 4)] },
        },
      }),
    );

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ code: 'POINTS_BELOW_SINK_POINTS', path: ['sides', 'A', 'players', 0, 'points'] }],
    });
    expect(await rows('games')).toBe(0);
  });

  it.each<[string, (t: Table) => unknown]>([
    ['a season game without its season or teams', (t) => ({ ...game(t), kind: 'season' })],
    ['a missing winner', (t) => ({ ...game(t), winner: undefined })],
    [
      'three players on one side',
      (t) =>
        game(t, {
          sides: {
            A: { players: [line(t.ana, 4), line(t.bo, 4), line(t.cy, 3)] },
            B: { players: [line(t.di, 9)] },
          },
        }),
    ],
    [
      '100 points',
      (t) =>
        game(t, {
          sides: {
            A: { players: [line(t.ana, 100), line(t.bo, 5)] },
            B: { players: [line(t.cy, 5), line(t.di, 4)] },
          },
        }),
    ],
    [
      'a client-sent sub flag, which the server derives',
      (t) => {
        const body = game(t);
        return {
          ...body,
          sides: {
            ...body.sides,
            A: { players: [{ ...line(t.ana, 6), isSub: true }, line(t.bo, 5)] },
          },
        };
      },
    ],
    ['an unknown key', (t) => ({ ...game(t), leagueId: randomUUID() })],
  ])('rejects %s with 422 VALIDATION', async (_label, make) => {
    const t = await table();

    const res = await submit(t, t.ana.caller, make(t));

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await rows('games')).toBe(0);
  });
});

describe('rules violations', () => {
  it('rejects a game that breaks the rules with 422 RULES_VIOLATION and the violations', async () => {
    const t = await table();

    const res = await submit(t, t.ana.caller, marginTooSmall(t));

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: 'RULES_VIOLATION',
      message: expect.any(String),
      details: [{ code: 'MARGIN_TOO_SMALL', message: expect.any(String) }],
    });
    expect(await rows('games')).toBe(0);
  });

  it('stores a rule-breaking game sent for commissioner review as awaiting an override', async () => {
    const t = await table();

    const recorded = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));

    expect(recorded.status).toBe('pending');
    expect(recorded.openRevision).toMatchObject({
      status: 'open',
      overrideStatus: 'requested',
      ruleViolations: [{ code: 'MARGIN_TOO_SMALL', message: expect.any(String) }],
    });
  });

  it('asks for no review when a game sent for review breaks no rule', async () => {
    const t = await table();

    const recorded = await submitted(t, t.ana.caller, game(t, { requestOverride: true }));

    expect(recorded.openRevision!.overrideStatus).toBeNull();
  });
});

describe('idempotency', () => {
  it('returns the original game with 200 when a submission is retried, storing nothing new', async () => {
    const t = await table();
    const body = game(t);
    const first = await submitted(t, t.ana.caller, body);

    const retry = await submit(t, t.ana.caller, body);

    expect(retry.status).toBe(200);
    expect(GameResponse.parse(await retry.json()).game).toEqual(first);
    expect(await rows('games')).toBe(1);
    expect(await rows('game_revisions')).toBe(1);
    expect(await rows('confirmations')).toBe(1);
  });

  it('replays a game whose window has closed as expired', async () => {
    const t = await table();
    const body = game(t);
    await submitted(t, t.ana.caller, body);
    clock.advance(7 * DAY);

    const retry = await submit(t, t.ana.caller, body);

    expect(retry.status).toBe(200);
    expect(GameResponse.parse(await retry.json()).game).toMatchObject({
      status: 'expired',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: null,
    });
    expect(await rows('games')).toBe(1);
  });

  it('replays the original game even after the league rules change', async () => {
    const t = await table();
    const body = game(t);
    const first = await submitted(t, t.ana.caller, body);
    expect((await patchLeague(t, 'rules', { targetScore: 21 })).status).toBe(200);

    const retry = await submit(t, t.ana.caller, body);

    expect(retry.status).toBe(200);
    expect(GameResponse.parse(await retry.json()).game).toEqual(first);
  });

  it('refuses the same key with a different payload with 409 and keeps the original', async () => {
    const t = await table();
    const body = game(t);
    const first = await submitted(t, t.ana.caller, body);

    const res = await submit(t, t.ana.caller, { ...body, winner: 'B' });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await rows('games')).toBe(1);
    const replay = await submit(t, t.ana.caller, body);
    expect(GameResponse.parse(await replay.json()).game).toEqual(first);
  });

  it('scopes the key to the submitter', async () => {
    const t = await table();
    const body = game(t);
    const anas = await submitted(t, t.ana.caller, body);

    const bos = await submitted(t, t.bo.caller, body);

    expect(bos.id).not.toBe(anas.id);
    expect(await rows('games')).toBe(2);
  });

  it('stores one game when the same submission races itself', async () => {
    const t = await table();
    const body = game(t);

    // Hold back every insert into games until both requests have checked for the key.
    let racing: Promise<Response[]> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`lock table games in share mode`);
      racing = Promise.all([submit(t, t.ana.caller, body), submit(t, t.ana.caller, body)]);
      await waitForLockWaiters(api.db, 2);
    });
    const responses = await racing!;

    expect(responses.map((r) => r.status).toSorted()).toEqual([200, 201]);
    const [a, b] = await Promise.all(
      responses.map(async (r) => GameResponse.parse(await r.json())),
    );
    expect(a!.game).toEqual(b!.game);
    expect(await rows('games')).toBe(1);
    expect(await rows('game_revisions')).toBe(1);
    expect(await rows('revision_players')).toBe(4);
    expect(await rows('confirmations')).toBe(1);
  });
});

describe('confirming a revision', () => {
  it('leaves the game uncounted while fewer than four players have confirmed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    await confirmed(t, t.bo.caller, g);
    const afterCy = await confirmed(t, t.cy.caller, g);

    expect(afterCy).toMatchObject({ status: 'pending', confirmedRevision: null });
    expect(confirmationsOf(afterCy)).toEqual(['player', 'player', 'player', null]);
    expect(await countedRevision(g.id)).toBeNull();
  });

  it('confirms the game, so it counts, when the fourth player confirms', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    const afterDi = await confirmed(t, t.di.caller, g);

    expect(afterDi).toEqual({
      ...g,
      status: 'confirmed',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: {
        ...g.openRevision,
        status: 'confirmed',
        players: g.openRevision!.players.map((p) => ({ ...p, confirmation: 'player' })),
      },
    });
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it('treats a repeated confirmation as a no-op', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const first = await confirmed(t, t.bo.caller, g);

    const again = await confirmed(t, t.bo.caller, g);

    expect(again).toEqual(first);
    expect(await rows('confirmations')).toBe(2);
  });

  it("treats the submitter's confirmation as already given", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const again = await confirmed(t, t.ana.caller, g);

    expect(again).toEqual(g);
    expect(await rows('confirmations')).toBe(1);
  });

  it('answers a repeated final confirmation with the confirmed game', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const final = await confirmed(t, t.di.caller, g);

    const again = await confirmed(t, t.di.caller, g);

    expect(again).toEqual(final);
  });

  it('refuses a member who did not play with 403, even a commissioner', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const g = await submitted(
      t,
      t.bo.caller,
      game(t, {
        sides: {
          A: { players: [line(ed, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 4)] },
        },
      }),
    );

    const res = await confirm(t, t.ana.caller, g.id, g.openRevision!.id);

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('confirmations')).toBe(1);
  });

  it('gives 404 for a revision that belongs to a different game', async () => {
    const t = await table();
    const first = await submitted(t, t.ana.caller, game(t));
    const second = await submitted(t, t.ana.caller, game(t));

    const res = await confirm(t, t.bo.caller, first.id, second.openRevision!.id);

    expect(res.status).toBe(404);
    expect(await rows('confirmations')).toBe(2);
  });

  it.each([
    ['an unknown game id', randomUUID()],
    ['a malformed game id', 'not-a-uuid'],
  ])('gives 404 for %s', async (_label, gameId) => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await confirm(t, t.bo.caller, gameId, g.openRevision!.id);

    expect(res.status).toBe(404);
  });

  it('accepts the game and revision ids in upper case', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await confirm(t, t.bo.caller, g.id.toUpperCase(), g.openRevision!.id.toUpperCase());

    expect(res.status).toBe(200);
    expect(confirmationsOf(GameResponse.parse(await res.json()).game)).toEqual([
      'player',
      'player',
      null,
      null,
    ]);
  });

  it('rejects a body with unknown keys with 422 VALIDATION', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await confirm(t, t.bo.caller, g.id, g.openRevision!.id, { points: 11 });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await rows('confirmations')).toBe(1);
  });

  it('keeps a rule-breaking revision uncounted after all four confirm while its review is pending', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    const afterDi = await confirmed(t, t.di.caller, g);

    expect(afterDi).toMatchObject({
      status: 'pending',
      confirmedRevision: null,
      openRevision: { status: 'open', overrideStatus: 'requested' },
    });
    expect(confirmationsOf(afterDi)).toEqual(['player', 'player', 'player', 'player']);
    expect(await countedRevision(g.id)).toBeNull();
  });
});

describe('concurrent confirmations', () => {
  it('confirms the game exactly once when the last two confirmations race', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    const [audit, outbox] = [await rows('audit_events'), await rows('email_outbox')];
    const rid = g.openRevision!.id;

    const results = await raceOn(g.id, () => [
      confirm(t, t.cy.caller, g.id, rid),
      confirm(t, t.di.caller, g.id, rid),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // The one that ran second saw all four confirmations and made the transition.
    expect(results.map((r) => r.game.status).toSorted()).toEqual(['confirmed', 'pending']);
    expect(await countedRevision(g.id)).toBe(rid);
    expect(await rows('confirmations')).toBe(4);
    expect(await rows('audit_events')).toBe(audit);
    expect(await rows('email_outbox')).toBe(outbox);
  });

  it("records one confirmation when a player's final confirmation races itself", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const rid = g.openRevision!.id;

    const results = await raceOn(g.id, () => [
      confirm(t, t.di.caller, g.id, rid),
      confirm(t, t.di.caller, g.id, rid),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.game).toEqual(results[1]!.game);
    expect(results[0]!.game.status).toBe('confirmed');
    expect(await rows('confirmations')).toBe(4);
  });
});

describe('the confirmation window', () => {
  it('accepts a confirmation 1 s before the window closes', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY - SECOND);

    const afterBo = await confirmed(t, t.bo.caller, g);

    expect(confirmationsOf(afterBo)).toEqual(['player', 'player', null, null]);
  });

  it('refuses the final confirmation with 409 once the window has closed, so the game never counts', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    clock.advance(7 * DAY);

    const res = await confirm(t, t.di.caller, g.id, g.openRevision!.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('confirmations')).toBe(3);
  });

  it('answers a repeated confirmation after the window closes with the expired game', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    const again = await confirmed(t, t.ana.caller, g);

    expect(again).toMatchObject({
      status: 'expired',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: null,
    });
    expect(await storedStatus(g.id)).toBe('expired');
  });
});

describe('the expiry sweep', () => {
  const sweep = (opts?: { batchSize?: number; maxBatches?: number }) =>
    sweepExpired({ db: api.db, clock }, opts);

  it('leaves a game open 1 s before its window closes', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY - SECOND);

    expect(await sweep()).toEqual({ expired: 0, done: true });

    expect(await storedStatus(g.id)).toBe('pending');
    expect(await revisionStatus(g.openRevision!.id)).toBe('open');
  });

  it('marks a game and its open revision expired once the window has closed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    expect(await sweep()).toEqual({ expired: 1, done: true });

    const [stored] = await api.db.execute(
      sql`select status, open_revision_id, window_expires_at, confirmed_revision_id
          from games where id = ${g.id}`,
    );
    expect(stored).toEqual({
      status: 'expired',
      open_revision_id: null,
      window_expires_at: null,
      confirmed_revision_id: null,
    });
    expect(await revisionStatus(g.openRevision!.id)).toBe('expired');
  });

  it('never counts a game it expired, even when the last player then confirms', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    clock.advance(7 * DAY);
    await sweep();

    const late = await confirm(t, t.di.caller, g.id, g.openRevision!.id);

    expect(late.status).toBe(409);
    expect((await errorOf(late)).code).toBe('WINDOW_CLOSED');
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('counted_results')).toBe(0);
  });

  it('leaves a confirmed game counting', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    await confirmed(t, t.di.caller, g);
    clock.advance(30 * DAY);

    expect(await sweep()).toEqual({ expired: 0, done: true });

    expect(await storedStatus(g.id)).toBe('confirmed');
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it('expires lapsed games in every league', async () => {
    const x = await table();
    const { self: yan, ...l } = await league('Garage League', 'yan@example.com', 'Yan');
    const y: Table = {
      ...l,
      ana: yan,
      bo: await member(l, 'pat@example.com', 'Pat'),
      cy: await member(l, 'quinn@example.com', 'Quinn'),
      di: await member(l, 'rae@example.com', 'Rae'),
    };
    const inX = await submitted(x, x.ana.caller, game(x));
    const inY = await submitted(y, y.ana.caller, game(y));
    clock.advance(7 * DAY);

    expect(await sweep()).toEqual({ expired: 2, done: true });

    expect(await storedStatus(inX.id)).toBe('expired');
    expect(await storedStatus(inY.id)).toBe('expired');
  });

  it('skips a game a write holds locked, leaving that write to settle it', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    const swept = await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from games where id = ${g.id} for update`);
      return sweep();
    });

    expect(swept).toEqual({ expired: 0, done: true });
    expect(await storedStatus(g.id)).toBe('pending');
  });

  it('works through more lapsed games than one batch holds', async () => {
    const t = await table();
    const recorded: Game[] = [];
    for (let i = 0; i < 5; i++) recorded.push(await submitted(t, t.ana.caller, game(t)));
    clock.advance(7 * DAY);

    expect(await sweep({ batchSize: 2 })).toEqual({ expired: 5, done: true });

    for (const g of recorded) expect(await storedStatus(g.id)).toBe('expired');
  });

  it('stops at its batch budget and reports the backlog, which the next sweep clears', async () => {
    const t = await table();
    for (let i = 0; i < 5; i++) await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    const first = await sweep({ batchSize: 2, maxBatches: 2 });
    const second = await sweep({ batchSize: 2, maxBatches: 2 });

    expect(first).toEqual({ expired: 4, done: false });
    expect(second).toEqual({ expired: 1, done: true });
  });

  it.each([
    ['a batch size of 0', { batchSize: 0 }],
    ['a fractional batch size', { batchSize: 1.5 }],
    ['a batch budget of 0', { maxBatches: 0 }],
  ])('refuses %s', async (_label, opts) => {
    await expect(sweep(opts)).rejects.toThrow(RangeError);
  });
});

describe('the inbox', () => {
  it('lists the open revisions awaiting my confirmation, soonest to expire first', async () => {
    const t = await table();
    const later = await submitted(t, t.ana.caller, game(t));
    expect((await patchLeague(t, 'settings', { confirmationWindowDays: 3 })).status).toBe(200);
    clock.advance(60 * SECOND);
    const sooner = await submitted(t, t.cy.caller, game(t));

    expect(await inbox(t, t.bo.caller)).toEqual([sooner, later]);
  });

  it('leaves out a revision I submitted, which counts as my confirmation', async () => {
    const t = await table();
    await submitted(t, t.ana.caller, game(t));
    const cys = await submitted(t, t.cy.caller, game(t));

    expect(await inbox(t, t.ana.caller)).toEqual([cys]);
  });

  it('drops a revision once I confirm it, and shows my confirmation to the others', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    await confirmed(t, t.bo.caller, g);

    expect(await inbox(t, t.bo.caller)).toEqual([]);
    const [forCy] = await inbox(t, t.cy.caller);
    expect(confirmationsOf(forCy!)).toEqual(['player', 'player', null, null]);
  });

  it('leaves out games I did not play in', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    await submitted(t, t.ana.caller, game(t));

    expect(await inbox(t, ed.caller)).toEqual([]);
  });

  it('leaves out a game once all four players have confirmed it', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    await confirmed(t, t.di.caller, g);

    for (const p of [t.ana, t.bo, t.cy, t.di]) expect(await inbox(t, p.caller)).toEqual([]);
  });

  it('lists a revision awaiting commissioner review, which still needs my confirmation', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));

    expect(await inbox(t, t.bo.caller)).toEqual([g]);
  });

  it('drops a revision when its window closes, with nothing written to the game', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY - SECOND);
    expect(await inbox(t, t.bo.caller)).toEqual([g]);

    clock.advance(SECOND);

    expect(await inbox(t, t.bo.caller)).toEqual([]);
    expect(await storedStatus(g.id)).toBe('pending');
  });

  it(`lists at most ${INBOX_MAX} games, the ones whose windows close soonest`, async () => {
    const t = await table();
    // Spread across Bo's three co-players, so none of them reaches the game write limit.
    const submitters = [t.ana, t.cy, t.di];
    const recorded: Game[] = [];
    for (let i = 0; i <= INBOX_MAX; i++) {
      recorded.push(await submitted(t, submitters[i % 3]!.caller, game(t)));
      clock.advance(SECOND);
    }

    const listed = await inbox(t, t.bo.caller);

    expect(listed.map((g) => g.id)).toEqual(recorded.slice(0, INBOX_MAX).map((g) => g.id));
  });

  it("lists only this league's games for a player in two leagues", async () => {
    const x = await table();
    const { self: yan, ...l } = await league('Garage League', 'yan@example.com', 'Yan');
    const y: Table = {
      ...l,
      ana: yan,
      bo: await member(l, 'bo@example.com', 'Bo'),
      cy: await member(l, 'pat@example.com', 'Pat'),
      di: await member(l, 'quinn@example.com', 'Quinn'),
    };
    const inX = await submitted(x, x.ana.caller, game(x));
    const inY = await submitted(y, y.ana.caller, game(y));

    expect(await inbox(x, x.bo.caller)).toEqual([inX]);
    expect(await inbox(y, y.bo.caller)).toEqual([inY]);
  });
});

// Ana and Bo beat Cy and Di 11–10 in a correction, one point short of the default win-by.
const correctedMarginTooSmall = (t: Table): Partial<CorrectGameBody> => ({
  sides: {
    A: { players: [line(t.ana, 6), line(t.bo, 5)] },
    B: { players: [line(t.cy, 5), line(t.di, 5)] },
  },
});

async function pointsCounted(membershipId: string): Promise<number[]> {
  const counted = await api.db.execute<{ points: number }>(
    sql`select points from counted_results where membership_id = ${membershipId}`,
  );
  return counted.map((r) => r.points);
}

describe('correcting a game', () => {
  it('replaces the open revision with the corrected result as revision 2', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(fixed).toMatchObject({ id: g.id, status: 'pending', confirmedRevision: null });
    expect(fixed.openRevision).toEqual({
      id: expect.any(String),
      number: 2,
      status: 'open',
      createdBy: t.di.membershipId,
      playedAt: '2026-10-18T11:30:00.000Z',
      winner: 'A',
      ruleViolations: [],
      overrideStatus: null,
      teams: null,
      players: [
        expect.objectContaining({ membershipId: t.ana.membershipId, side: 'A', points: 6 }),
        expect.objectContaining({ membershipId: t.bo.membershipId, side: 'A', points: 5 }),
        expect.objectContaining({ membershipId: t.cy.membershipId, side: 'B', points: 5 }),
        expect.objectContaining({ membershipId: t.di.membershipId, side: 'B', points: 3 }),
      ],
    });
    expect(fixed.openRevision!.id).not.toBe(g.openRevision!.id);
    expect(await revisionStatus(g.openRevision!.id)).toBe('superseded');
  });

  it("resets the earlier confirmations, keeping only the author's", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(confirmationsOf(fixed)).toEqual([null, null, null, 'player']);
    // The three confirmations of revision 1 stay with it, as history.
    expect(await rows('confirmations')).toBe(4);
  });

  it('keeps the confirmation window where the first submission set it', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(3 * DAY);

    const fixed = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(fixed.windowExpiresAt).toBe('2026-10-25T12:00:00.000Z');
    expect(fixed.windowExpiresAt).toBe(g.windowExpiresAt);
  });

  it('counts the corrected numbers, not the original ones, once all four confirm the correction', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));
    await confirmed(t, t.ana.caller, fixed);
    await confirmed(t, t.bo.caller, fixed);

    const final = await confirmed(t, t.cy.caller, fixed);

    expect(final.status).toBe('confirmed');
    expect(await countedRevision(g.id)).toBe(fixed.openRevision!.id);
    expect(await pointsCounted(t.di.membershipId)).toEqual([3]);
  });

  it('refuses a confirmation of the superseded revision with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await corrected(t, t.di.caller, g.id, correction(t, g));

    const res = await confirm(t, t.bo.caller, g.id, g.openRevision!.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('confirmations')).toBe(2);
  });

  it('puts the game back in the inbox of a player whose confirmation it reset', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(await inbox(t, t.bo.caller)).toEqual([fixed]);
    expect(await inbox(t, t.di.caller)).toEqual([]);
  });

  it('numbers a correction of a correction after it, superseding it in turn', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const second = await corrected(t, t.di.caller, g.id, correction(t, g));

    const third = await corrected(t, t.bo.caller, g.id, correction(t, second));

    expect(third.openRevision).toMatchObject({ number: 3, createdBy: t.bo.membershipId });
    expect(await revisionStatus(second.openRevision!.id)).toBe('superseded');
  });

  it('lets a correction move the same four players between sides', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const fixed = await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, g, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.cy, 5)] },
          B: { players: [line(t.bo, 5), line(t.di, 3)] },
        },
      }),
    );

    expect(fixed.openRevision!.players.map((p) => [p.membershipId, p.side])).toEqual([
      [t.ana.membershipId, 'A'],
      [t.cy.membershipId, 'A'],
      [t.bo.membershipId, 'B'],
      [t.di.membershipId, 'B'],
    ]);
  });

  it('accepts the game and base revision ids in upper case', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const fixed = await corrected(
      t,
      t.di.caller,
      g.id.toUpperCase(),
      correction(t, g, { baseRevisionId: g.openRevision!.id.toUpperCase() }),
    );

    expect(fixed.openRevision!.number).toBe(2);
  });

  it.each([
    ['an unknown game id', randomUUID()],
    ['a malformed game id', 'not-a-uuid'],
  ])('gives 404 for %s', async (_label, gameId) => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await correct(t, t.di.caller, gameId, correction(t, g));

    expect(res.status).toBe(404);
    expect(await rows('game_revisions')).toBe(1);
  });
});

describe('who may correct a game', () => {
  it('refuses a member who did not play with 403, even a commissioner', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const sides = {
      A: { players: [line(ed, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 3)] },
    };
    const g = await submitted(
      t,
      t.bo.caller,
      game(t, { sides: { ...sides, B: { players: [line(t.cy, 5), line(t.di, 4)] } } }),
    );

    const res = await correct(t, t.ana.caller, g.id, correction(t, g, { sides }));

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('game_revisions')).toBe(1);
    expect(await revisionStatus(g.openRevision!.id)).toBe('open');
  });

  it('refuses a correction that leaves its author out of the game with 403', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await correct(
      t,
      t.di.caller,
      g.id,
      correction(t, g, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(ed, 3)] },
        },
      }),
    );

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('game_revisions')).toBe(1);
  });
});

describe('stale and closed corrections', () => {
  it('refuses a correction of a revision that was already corrected with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    const res = await correct(t, t.cy.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
    expect(await revisionStatus(fixed.openRevision!.id)).toBe('open');
  });

  it.each<[string, (other: Game) => string]>([
    ['an unknown revision', () => randomUUID()],
    ['the open revision of another game', (other) => other.openRevision!.id],
  ])('refuses a base that is %s with 409 STALE_REVISION', async (_label, baseOf) => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const other = await submitted(t, t.ana.caller, game(t));

    const res = await correct(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { baseRevisionId: baseOf(other) }),
    );

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
    expect(await revisionStatus(other.openRevision!.id)).toBe('open');
  });

  it('accepts a correction 1 s before the window closes', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY - SECOND);

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(fixed.openRevision!.number).toBe(2);
  });

  it('refuses a correction with 409 WINDOW_CLOSED once the window has closed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    const res = await correct(t, t.di.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await rows('game_revisions')).toBe(1);
    expect(await countedRevision(g.id)).toBeNull();
  });
});

describe('validating a correction', () => {
  it('checks a correction against the rules snapshot, not rules edited since', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    expect((await patchLeague(t, 'rules', { targetScore: 21 })).status).toBe(200);

    // 11–8 is a legal end only under the snapshot's target of 11.
    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(fixed.rulesSnapshot).toEqual(DEFAULT_RULES);
    expect(fixed.openRevision!.ruleViolations).toEqual([]);
  });

  it('refuses a correction that breaks the snapshot, even when the edited rules allow it', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    expect((await patchLeague(t, 'rules', { winBy: 1 })).status).toBe(200);

    const res = await correct(t, t.di.caller, g.id, correction(t, g, correctedMarginTooSmall(t)));

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: 'RULES_VIOLATION',
      message: expect.any(String),
      details: [{ code: 'MARGIN_TOO_SMALL', message: expect.any(String) }],
    });
    expect(await rows('game_revisions')).toBe(1);
    expect(await revisionStatus(g.openRevision!.id)).toBe('open');
  });

  it('stores a rule-breaking correction sent for commissioner review as awaiting an override', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const fixed = await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );

    expect(fixed.openRevision).toMatchObject({
      status: 'open',
      overrideStatus: 'requested',
      ruleViolations: [{ code: 'MARGIN_TOO_SMALL', message: expect.any(String) }],
    });
  });

  it('drops the review request when a correction fixes the rule-breaking result', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(fixed.openRevision).toMatchObject({ ruleViolations: [], overrideStatus: null });
  });

  it("does not carry the base revision's approved override over to the correction", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));
    await decided(t, g, 'approve');

    const refused = await correct(
      t,
      t.di.caller,
      g.id,
      correction(t, g, correctedMarginTooSmall(t)),
    );
    const fixed = await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );

    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).code).toBe('RULES_VIOLATION');
    expect(fixed.openRevision!.overrideStatus).toBe('requested');
  });

  it('rejects a correction played in the future with 422 VALIDATION', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await correct(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { playedAt: '2026-10-18T12:00:01.000Z' }),
    );

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ path: ['playedAt'] }],
    });
    expect(await rows('game_revisions')).toBe(1);
  });

  // Otherwise a player could swap out the others, who could then neither see the game nor
  // contest it, since only a revision's players may confirm or correct it.
  it('refuses a correction that swaps in someone who did not play with 422 VALIDATION, naming the entry', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);

    const res = await correct(
      t,
      t.di.caller,
      g.id,
      correction(t, g, {
        sides: {
          A: { players: [line(t.ana, 6), line(ed, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 3)] },
        },
      }),
    );

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      details: [{ code: 'NOT_IN_GAME', path: ['sides', 'A', 'players', 1, 'membershipId'] }],
    });
    expect(await rows('game_revisions')).toBe(1);
    expect(await revisionStatus(g.openRevision!.id)).toBe('open');
  });

  it.each<[string, (t: Table, g: Game) => unknown]>([
    [
      'a player listed twice',
      (t, g) =>
        correction(t, g, {
          sides: {
            A: { players: [line(t.ana, 6), line(t.bo, 5)] },
            B: { players: [line(t.cy, 5), line(t.bo, 3)] },
          },
        }),
    ],
    ['a missing base revision', (t, g) => ({ ...correction(t, g), baseRevisionId: undefined })],
    [
      'a kind, which a correction cannot change',
      (t, g) => ({ ...correction(t, g), kind: 'season' }),
    ],
    ['an unknown key', (t, g) => ({ ...correction(t, g), leagueId: randomUUID() })],
  ])('rejects %s with 422 VALIDATION', async (_label, make) => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await correct(t, t.di.caller, g.id, make(t, g));

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await rows('game_revisions')).toBe(1);
    expect(await revisionStatus(g.openRevision!.id)).toBe('open');
  });
});

describe('concurrent corrections', () => {
  it('accepts exactly one of two corrections racing on the same revision', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const responses = await queuedOn(g.id, () => [
      correct(t, t.bo.caller, g.id, correction(t, g)),
      correct(t, t.di.caller, g.id, correction(t, g)),
    ]);

    expect(responses.map((r) => r.status).toSorted()).toEqual([201, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect((await errorOf(loser)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
    expect(await rows('confirmations')).toBe(2);
  });

  // The correction is based on numbers its author saw, so it lands either way: it supersedes
  // the open revision, or, once the final confirmation has gone first, reopens the game.
  it('applies a correction racing the final confirmation after it, or refuses the confirmation', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const rid = g.openRevision!.id;

    const [confirmRes, correctRes] = await queuedOn(g.id, () => [
      confirm(t, t.di.caller, g.id, rid),
      correct(t, t.bo.caller, g.id, correction(t, g)),
    ]);

    expect(correctRes!.status).toBe(201);
    const after = GameResponse.parse(await correctRes!.json()).game;
    expect(after.openRevision!.number).toBe(2);
    expect(await rows('game_revisions')).toBe(2);
    if (confirmRes!.ok) {
      expect(after).toMatchObject({ status: 'confirmed', confirmedRevision: { id: rid } });
      expect(await countedRevision(g.id)).toBe(rid);
    } else {
      expect(confirmRes!.status).toBe(409);
      expect((await errorOf(confirmRes!)).code).toBe('STALE_REVISION');
      expect(after).toMatchObject({ status: 'pending', confirmedRevision: null });
      expect(await countedRevision(g.id)).toBeNull();
    }
  });
});

describe('reopening a confirmed exhibition game', () => {
  // The default game, confirmed by all four players at the clock's current time.
  async function confirmedGame(t: Table): Promise<Game> {
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    return confirmed(t, t.di.caller, g);
  }

  // Each player still waiting on the open revision shown in `g` confirms it, in seat order.
  async function confirmedByAll(t: Table, g: Game): Promise<Game> {
    const waiting = [t.ana, t.bo, t.cy, t.di].filter((p) =>
      g.openRevision!.players.some((s) => s.membershipId === p.membershipId && !s.confirmation),
    );
    let latest = g;
    for (const p of waiting) latest = await confirmed(t, p.caller, g);
    return latest;
  }

  it('opens a correction of the confirmed revision as the next revision, with a new window', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    clock.advance(DAY);

    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(reopened).toMatchObject({
      id: g.id,
      status: 'confirmed',
      windowExpiresAt: '2026-10-26T12:00:00.000Z',
      confirmedRevision: g.confirmedRevision,
    });
    expect(reopened.openRevision).toMatchObject({
      number: 2,
      status: 'open',
      createdBy: t.bo.membershipId,
    });
    expect(confirmationsOf(reopened)).toEqual([null, 'player', null, null]);
  });

  it('keeps counting the confirmed result while the correction is open', async () => {
    const t = await table();
    const g = await confirmedGame(t);

    await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(await countedRevision(g.id)).toBe(g.confirmedRevision!.id);
    expect(await revisionStatus(g.confirmedRevision!.id)).toBe('confirmed');
    expect(await pointsCounted(t.di.membershipId)).toEqual([4]);
  });

  it('counts the correction in place of the old result once all four confirm it', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    const final = await confirmedByAll(t, reopened);

    expect(final).toMatchObject({ status: 'confirmed', openRevision: null, windowExpiresAt: null });
    expect(final.confirmedRevision!.id).toBe(reopened.openRevision!.id);
    expect(await revisionStatus(g.confirmedRevision!.id)).toBe('superseded');
    expect(await pointsCounted(t.di.membershipId)).toEqual([3]);
    expect(await rows('counted_results')).toBe(4);
  });

  it('puts the reopened game in the inbox of the other three players', async () => {
    const t = await table();
    const g = await confirmedGame(t);

    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(await inbox(t, t.ana.caller)).toEqual([reopened]);
    expect(await inbox(t, t.di.caller)).toEqual([reopened]);
    expect(await inbox(t, t.bo.caller)).toEqual([]);
  });

  it("starts the new window from the league's setting at reopening", async () => {
    const t = await table();
    const g = await confirmedGame(t);
    expect((await patchLeague(t, 'settings', { confirmationWindowDays: 3 })).status).toBe(200);

    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(reopened.windowExpiresAt).toBe('2026-10-21T12:00:00.000Z');
  });

  it('keeps the reopened window when the open correction is corrected again', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));
    clock.advance(2 * DAY);

    const again = await corrected(t, t.cy.caller, g.id, correction(t, reopened));

    expect(again.windowExpiresAt).toBe(reopened.windowExpiresAt);
    expect(again.openRevision!.number).toBe(3);
    expect(again.confirmedRevision!.id).toBe(g.confirmedRevision!.id);
    expect(await revisionStatus(reopened.openRevision!.id)).toBe('superseded');
  });

  it('checks a reopening against the rules snapshot, not rules edited since', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    expect((await patchLeague(t, 'rules', { targetScore: 21 })).status).toBe(200);

    // 11–8 is a legal end only under the snapshot's target of 11.
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(reopened.openRevision!.ruleViolations).toEqual([]);
  });

  it('refuses a member who did not play with 403, even a commissioner', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const sides = {
      A: { players: [line(ed, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 4)] },
    };
    const g = await submitted(t, t.bo.caller, game(t, { sides }));
    await confirmed(t, ed.caller, g);
    await confirmed(t, t.cy.caller, g);
    const c = await confirmed(t, t.di.caller, g);

    const res = await correct(t, t.ana.caller, g.id, correction(t, c, { sides }));

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('game_revisions')).toBe(1);
  });

  it("gives 404 to a member of another league, even through their own league's path", async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const other = await league('Attic League', 'zed@example.com', 'Zed');

    const res = await correct(other, other.commissioner, g.id, correction(t, g));

    expect(res.status).toBe(404);
    expect(await rows('game_revisions')).toBe(1);
  });

  it('accepts a reopening 1 s before the correction window closes', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    clock.advance(30 * DAY - SECOND);

    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    expect(reopened.openRevision!.number).toBe(2);
  });

  it('refuses a reopening with 409 WINDOW_CLOSED once the correction window has closed', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    clock.advance(15 * DAY);
    // Bo uses the app meanwhile, so their session outlives the 30-day correction window.
    await inbox(t, t.bo.caller);
    clock.advance(15 * DAY);

    const res = await correct(t, t.bo.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await rows('game_revisions')).toBe(1);
    expect(await countedRevision(g.id)).toBe(g.confirmedRevision!.id);
  });

  it('measures the correction window from when the game was first confirmed', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    clock.advance(20 * DAY);
    const final = await confirmedByAll(t, await corrected(t, t.bo.caller, g.id, correction(t, g)));
    clock.advance(10 * DAY);

    const res = await correct(t, t.cy.caller, g.id, correction(t, final));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await countedRevision(g.id)).toBe(final.confirmedRevision!.id);
  });

  it('closes the correction window by the length the league has set at reopening', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    expect((await patchLeague(t, 'settings', { exhibitionCorrectionWindowDays: 10 })).status).toBe(
      200,
    );
    clock.advance(10 * DAY);

    const res = await correct(t, t.bo.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
  });

  it('refuses a reopening while a correction of the confirmed result is open with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));

    const res = await correct(t, t.cy.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
    expect(await revisionStatus(reopened.openRevision!.id)).toBe('open');
  });

  it('refuses a reopening based on a result the confirmed one replaced with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    await confirmedByAll(t, await corrected(t, t.bo.caller, g.id, correction(t, g)));

    const res = await correct(t, t.cy.caller, g.id, correction(t, g));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
  });

  it('keeps the old result counting when the correction expires unconfirmed', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));
    clock.advance(7 * DAY);

    const res = await confirm(t, t.ana.caller, g.id, reopened.openRevision!.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await storedStatus(g.id)).toBe('confirmed');
    expect(await countedRevision(g.id)).toBe(g.confirmedRevision!.id);
    expect(await pointsCounted(t.di.membershipId)).toEqual([4]);
  });

  it('has the sweep expire an unconfirmed correction, leaving the old result counting', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    const reopened = await corrected(t, t.bo.caller, g.id, correction(t, g));
    clock.advance(7 * DAY);

    expect(await sweepExpired({ db: api.db, clock })).toEqual({ expired: 1, done: true });

    expect(await storedStatus(g.id)).toBe('confirmed');
    expect(await revisionStatus(reopened.openRevision!.id)).toBe('expired');
    expect(await countedRevision(g.id)).toBe(g.confirmedRevision!.id);
  });

  it('lets a player reopen the game again once a correction has expired', async () => {
    const t = await table();
    const g = await confirmedGame(t);
    await corrected(t, t.bo.caller, g.id, correction(t, g));
    clock.advance(7 * DAY);

    const again = await corrected(t, t.cy.caller, g.id, correction(t, g));

    expect(again.openRevision).toMatchObject({ number: 3, createdBy: t.cy.membershipId });
    expect(again.windowExpiresAt).toBe('2026-11-01T12:00:00.000Z');
  });

  it('accepts exactly one of two reopenings racing on the confirmed revision', async () => {
    const t = await table();
    const g = await confirmedGame(t);

    const responses = await queuedOn(g.id, () => [
      correct(t, t.bo.caller, g.id, correction(t, g)),
      correct(t, t.di.caller, g.id, correction(t, g)),
    ]);

    expect(responses.map((r) => r.status).toSorted()).toEqual([201, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect((await errorOf(loser)).code).toBe('STALE_REVISION');
    expect(await rows('game_revisions')).toBe(2);
  });
});

describe('force-confirming', () => {
  // Bo submits a game Ed, Bo, Cy, and Di played, so Ana, the commissioner, sat it out.
  async function gameWithoutAna(t: Table): Promise<{ ed: Player; g: Game }> {
    const ed = await member(t, 'ed@example.com', 'Ed');
    const g = await submitted(
      t,
      t.bo.caller,
      game(t, {
        sides: {
          A: { players: [line(ed, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 4)] },
        },
      }),
    );
    return { ed, g };
  }

  it('confirms the game, so it counts, once a commissioner confirms for the silent players', async () => {
    const t = await table();
    const { ed, g } = await gameWithoutAna(t);

    const after = await forced(t, g, [ed, t.cy, t.di]);

    expect(after).toMatchObject({
      status: 'confirmed',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: { id: g.openRevision!.id, status: 'confirmed' },
    });
    expect(confirmationsOf(after)).toEqual(['forced', 'player', 'forced', 'forced']);
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it('records one audit entry per forced player, naming them, for every member to see', async () => {
    const t = await table();
    const { g } = await gameWithoutAna(t);
    await forced(t, g, [t.cy, t.di]);

    const events = await auditLog(t, t.bo.caller);

    const entry = (p: Player, displayName: string) => ({
      id: expect.any(String),
      createdAt: clock.now().toISOString(),
      actor: { membershipId: t.ana.membershipId, displayName: 'Ana' },
      actorWasParticipant: false,
      action: 'game.confirmation_forced',
      targetType: 'game',
      targetId: g.id,
      details: { revisionId: g.openRevision!.id, membershipId: p.membershipId },
      player: { membershipId: p.membershipId, displayName },
    });
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([entry(t.cy, 'Cy'), entry(t.di, 'Di')]));
  });

  it('flags the audit entry when the commissioner played in the game', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    await forced(t, g, [t.cy]);

    const [event] = await auditLog(t, t.cy.caller);
    expect(event).toMatchObject({ action: 'game.confirmation_forced', actorWasParticipant: true });
  });

  it('stores which commissioner forced each confirmation', async () => {
    const t = await table();
    const g = await submitted(t, t.bo.caller, game(t));

    await forced(t, g, [t.cy]);

    const stored = await api.db.execute<{ membership_id: string; kind: string; forced_by: string }>(
      sql`select membership_id, kind, forced_by from confirmations order by kind = 'forced'`,
    );
    expect([...stored]).toEqual([
      { membership_id: t.bo.membershipId, kind: 'player', forced_by: null },
      { membership_id: t.cy.membershipId, kind: 'forced', forced_by: t.ana.membershipId },
    ]);
  });

  it('leaves the game pending, and in the inbox of anyone still silent, until all four have confirmed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);

    const after = await forced(t, g, [t.cy]);

    expect(after).toMatchObject({ status: 'pending', confirmedRevision: null });
    expect(confirmationsOf(after)).toEqual(['player', 'player', 'forced', null]);
    expect(await countedRevision(g.id)).toBeNull();
    expect(await inbox(t, t.cy.caller)).toEqual([]);
    expect((await inbox(t, t.di.caller)).map((x) => x.id)).toEqual([g.id]);
  });

  it('skips a listed player who has already confirmed, auditing only the forced one', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);

    const after = await forced(t, g, [t.bo, t.cy]);

    expect(confirmationsOf(after)).toEqual(['player', 'player', 'forced', null]);
    const events = await auditLog(t, t.ana.caller);
    expect(events.map((e) => e.action === 'game.confirmation_forced' && e.player)).toEqual([
      { membershipId: t.cy.membershipId, displayName: 'Cy' },
    ]);
  });

  it('answers a repeated force-confirm with the game unchanged, even once it counts', async () => {
    const t = await table();
    const { ed, g } = await gameWithoutAna(t);
    const first = await forced(t, g, [ed, t.cy, t.di]);

    const again = await forced(t, g, [ed, t.cy, t.di]);

    expect(again).toEqual(first);
    expect(await rows('confirmations')).toBe(4);
    expect(await rows('audit_events')).toBe(3);
  });

  it('refuses a member who is not a commissioner with 403, even one who played', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await forceConfirm(t, t.bo.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.cy.membershipId],
    });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await rows('confirmations')).toBe(1);
    expect(await rows('audit_events')).toBe(0);
  });

  it('refuses a commissioner demoted while the request waited with 403', async () => {
    const t = await table();
    const g = await submitted(t, t.bo.caller, game(t));
    let pending: Promise<Response> | undefined;

    // The request passes the role check it can make up front, then waits to re-read the
    // membership while Ana loses the role.
    await api.db.transaction(async (tx) => {
      await tx.execute(
        sql`update memberships set role = 'member' where id = ${t.ana.membershipId}`,
      );
      pending = forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
        membershipIds: [t.cy.membershipId],
      });
      await waitForLockWaiters(api.db, 1);
    });
    const res = await pending!;

    expect(res.status).toBe(403);
    expect(await rows('confirmations')).toBe(1);
    expect(await rows('audit_events')).toBe(0);
  });

  it('refuses a revision whose window has closed with 409 WINDOW_CLOSED, so the game never counts', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY);

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.bo.membershipId, t.cy.membershipId, t.di.membershipId],
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('confirmations')).toBe(1);
    expect(await rows('audit_events')).toBe(0);
  });

  it('accepts a force-confirm 1 s before the window closes', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(7 * DAY - SECOND);

    const after = await forced(t, g, [t.bo]);

    expect(confirmationsOf(after)).toEqual(['player', 'forced', null, null]);
  });

  it('refuses a superseded revision with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await corrected(t, t.di.caller, g.id, correction(t, g));

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.cy.membershipId],
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('audit_events')).toBe(0);
  });

  it('starts the confirmations over when a forced player corrects the result', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await forced(t, g, [t.di]);

    const after = await corrected(t, t.di.caller, g.id, correction(t, g));

    expect(after.openRevision!.number).toBe(2);
    expect(confirmationsOf(after)).toEqual([null, null, null, 'player']);
  });

  it('keeps a rule-breaking revision uncounted after forcing while its review is pending', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));

    const after = await forced(t, g, [t.bo, t.cy, t.di]);

    expect(after).toMatchObject({
      status: 'pending',
      confirmedRevision: null,
      openRevision: { status: 'open', overrideStatus: 'requested' },
    });
    expect(confirmationsOf(after)).toEqual(['player', 'forced', 'forced', 'forced']);
    expect(await countedRevision(g.id)).toBeNull();
  });

  it('refuses a listed member who did not play with 422 VALIDATION, naming the entry and forcing no one', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.cy.membershipId, ed.membershipId],
    });

    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION');
    expect(error.details).toEqual([
      { code: 'NOT_IN_GAME', path: ['membershipIds', 1], message: 'Not a player in this game' },
    ]);
    expect(await rows('confirmations')).toBe(1);
  });

  it('refuses a playing commissioner forcing their own confirmation with 422 VALIDATION', async () => {
    const t = await table();
    const g = await submitted(t, t.bo.caller, game(t));

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.cy.membershipId, t.ana.membershipId],
    });

    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION');
    expect(error.details).toEqual([
      { code: 'SELF', path: ['membershipIds', 1], message: 'Confirm your own result instead' },
    ]);
    expect(await rows('confirmations')).toBe(1);
  });

  it.each([
    ['no players', { membershipIds: [] }],
    ['an unknown key', { membershipIds: [randomUUID()], kind: 'player' }],
  ])('rejects a body with %s with 422 VALIDATION', async (_label, body) => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await rows('confirmations')).toBe(1);
  });

  it('gives 404 for a revision that belongs to a different game', async () => {
    const t = await table();
    const first = await submitted(t, t.ana.caller, game(t));
    const second = await submitted(t, t.ana.caller, game(t));

    const res = await forceConfirm(t, t.ana.caller, first.id, second.openRevision!.id, {
      membershipIds: [t.cy.membershipId],
    });

    expect(res.status).toBe(404);
    expect(await rows('confirmations')).toBe(2);
  });

  it("gives 404 to a commissioner of another league, even through their own league's path", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const other = await league('Attic League', 'zed@example.com', 'Zed');

    const res = await forceConfirm(other, other.commissioner, g.id, g.openRevision!.id, {
      membershipIds: [t.cy.membershipId],
    });

    expect(res.status).toBe(404);
    expect(await rows('confirmations')).toBe(1);
    expect(await rows('audit_events')).toBe(0);
  });

  it('accepts the game, revision, and player ids in upper case', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));

    const res = await forceConfirm(
      t,
      t.ana.caller,
      g.id.toUpperCase(),
      g.openRevision!.id.toUpperCase(),
      { membershipIds: [t.cy.membershipId.toUpperCase()] },
    );

    expect(res.status).toBe(200);
    expect(confirmationsOf(GameResponse.parse(await res.json()).game)).toEqual([
      'player',
      null,
      'forced',
      null,
    ]);
  });

  it("records one confirmation when a force-confirm races the player's own", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const rid = g.openRevision!.id;

    const results = await raceOn(g.id, () => [
      forceConfirm(t, t.ana.caller, g.id, rid, { membershipIds: [t.di.membershipId] }),
      confirm(t, t.di.caller, g.id, rid),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.game.status)).toEqual(['confirmed', 'confirmed']);
    expect(await rows('confirmations')).toBe(4);
    // Whichever ran first confirmed Di; the force is audited only if it was that one.
    const [di] = await api.db.execute<{ kind: string }>(
      sql`select kind from confirmations where membership_id = ${t.di.membershipId}`,
    );
    expect(await rows('audit_events')).toBe(di!.kind === 'forced' ? 1 : 0);
  });
});

describe('deciding an override', () => {
  // Bo sends Ed, Bo, Cy, and Di's 11–10 game for review, so Ana, the commissioner, sat it out.
  async function reviewWithoutAna(t: Table): Promise<Game> {
    const ed = await member(t, 'ed@example.com', 'Ed');
    return submitted(
      t,
      t.bo.caller,
      game(t, {
        sides: {
          A: { players: [line(ed, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 5)] },
        },
        requestOverride: true,
      }),
    );
  }

  // Ana's 11–10 game, sent for review.
  const sentForReview = (t: Table) =>
    submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));

  // Ana's 11–10 game, sent for review, then confirmed by Bo, Cy, and Di.
  async function confirmedAwaitingReview(t: Table): Promise<Game> {
    const g = await sentForReview(t);
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    return confirmed(t, t.di.caller, g);
  }

  async function promoted(t: League, p: Player): Promise<void> {
    const res = await call('POST', `/api/leagues/${t.leagueId}/members/${p.membershipId}/role`, {
      as: t.commissioner,
      body: { role: 'commissioner' },
    });
    expect(res.status).toBe(200);
  }

  it('confirms the game, so it counts, when a commissioner approves after all four have confirmed', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);

    const after = await decided(t, g, 'approve');

    expect(after).toMatchObject({
      status: 'confirmed',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: {
        id: g.openRevision!.id,
        status: 'confirmed',
        overrideStatus: 'approved',
      },
    });
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it('confirms the game on the last confirmation when a commissioner approved it first', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await decided(t, g, 'approve');
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    const after = await confirmed(t, t.di.caller, g);

    expect(after).toMatchObject({
      status: 'confirmed',
      confirmedRevision: { id: g.openRevision!.id, overrideStatus: 'approved' },
    });
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it('leaves an approved game pending until all four players have confirmed', async () => {
    const t = await table();
    const g = await sentForReview(t);

    const after = await decided(t, g, 'approve');

    expect(after).toMatchObject({
      status: 'pending',
      confirmedRevision: null,
      openRevision: { id: g.openRevision!.id, status: 'open', overrideStatus: 'approved' },
    });
    expect(await countedRevision(g.id)).toBeNull();
  });

  it('confirms an approved game once a commissioner force-confirms the silent players', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await decided(t, g, 'approve');

    const after = await forced(t, g, [t.bo, t.cy, t.di]);

    expect(after.status).toBe('confirmed');
    expect(await countedRevision(g.id)).toBe(g.openRevision!.id);
  });

  it.each(['approve', 'reject'] as const)(
    'stores which commissioner decided a %s',
    async (decision) => {
      const t = await table();
      const g = await sentForReview(t);

      await decided(t, g, decision);

      const stored = await api.db.execute<{ override_status: string; override_by: string }>(
        sql`select override_status, override_by from game_revisions`,
      );
      expect([...stored]).toEqual([
        {
          override_status: decision === 'approve' ? 'approved' : 'rejected',
          override_by: t.ana.membershipId,
        },
      ]);
    },
  );

  it.each(['approve', 'reject'] as const)(
    'records an audit entry of a %s for every member to see',
    async (decision) => {
      const t = await table();
      const g = await reviewWithoutAna(t);
      await decided(t, g, decision);

      const events = await auditLog(t, t.cy.caller);

      expect(events).toEqual([
        {
          id: expect.any(String),
          createdAt: clock.now().toISOString(),
          actor: { membershipId: t.ana.membershipId, displayName: 'Ana' },
          actorWasParticipant: false,
          action: 'game.override_decided',
          targetType: 'game',
          targetId: g.id,
          details: { revisionId: g.openRevision!.id, decision },
        },
      ]);
    },
  );

  it('flags the audit entry when the commissioner played in the game', async () => {
    const t = await table();
    const g = await sentForReview(t);

    await decided(t, g, 'approve');

    const [event] = await auditLog(t, t.bo.caller);
    expect(event).toMatchObject({ action: 'game.override_decided', actorWasParticipant: true });
  });

  it('rejects the revision, so the game does not count even with all four confirmations', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);

    const after = await decided(t, g, 'reject');

    expect(after).toMatchObject({
      status: 'pending',
      confirmedRevision: null,
      openRevision: { id: g.openRevision!.id, status: 'rejected', overrideStatus: 'rejected' },
    });
    expect(await countedRevision(g.id)).toBeNull();
  });

  it('drops a rejected revision from the inbox of players yet to confirm it', async () => {
    const t = await table();
    const g = await sentForReview(t);

    await decided(t, g, 'reject');

    expect(await inbox(t, t.bo.caller)).toEqual([]);
  });

  it('refuses confirming a rejected revision with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await decided(t, g, 'reject');

    const res = await confirm(t, t.bo.caller, g.id, g.openRevision!.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('confirmations')).toBe(1);
  });

  it('refuses force-confirming a rejected revision with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await decided(t, g, 'reject');

    const res = await forceConfirm(t, t.ana.caller, g.id, g.openRevision!.id, {
      membershipIds: [t.bo.membershipId],
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('confirmations')).toBe(1);
  });

  it('lets a player correct a rejected revision within the window, which keeps running', async () => {
    const t = await table();
    const g = await sentForReview(t);
    clock.advance(DAY);
    const rejected = await decided(t, g, 'reject');

    const fixed = await corrected(t, t.di.caller, g.id, correction(t, rejected));

    expect(fixed).toMatchObject({
      status: 'pending',
      windowExpiresAt: g.windowExpiresAt,
      openRevision: { number: 2, status: 'open', ruleViolations: [], overrideStatus: null },
    });
    expect(confirmationsOf(fixed)).toEqual([null, null, null, 'player']);
    expect(await revisionStatus(g.openRevision!.id)).toBe('superseded');
  });

  it('refuses correcting a rejected revision once the window has closed with 409 WINDOW_CLOSED', async () => {
    const t = await table();
    const g = await sentForReview(t);
    const rejected = await decided(t, g, 'reject');
    clock.advance(7 * DAY);

    const res = await correct(t, t.di.caller, g.id, correction(t, rejected));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await rows('game_revisions')).toBe(1);
  });

  it('expires a rejected game once its window closes, keeping the rejection', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await decided(t, g, 'reject');
    clock.advance(7 * DAY);

    await sweepExpired({ db: api.db, clock });

    expect(await storedStatus(g.id)).toBe('expired');
    expect(await revisionStatus(g.openRevision!.id)).toBe('rejected');
    expect(await countedRevision(g.id)).toBeNull();
  });

  it.each(['approve', 'reject'] as const)(
    'answers a repeated %s with the game unchanged, auditing it once',
    async (decision) => {
      const t = await table();
      const g = await confirmedAwaitingReview(t);
      const first = await decided(t, g, decision);

      const again = await decided(t, g, decision);

      expect(again).toEqual(first);
      expect(await rows('audit_events')).toBe(1);
    },
  );

  it.each([
    ['reversing an approval', 'approve', 'reject'],
    ['approving a rejected revision', 'reject', 'approve'],
  ] as const)('refuses %s with 409 NOT_AWAITING_REVIEW', async (_label, first, second) => {
    const t = await table();
    const g = await sentForReview(t);
    const before = await decided(t, g, first);

    const res = await override(t, t.ana.caller, g.id, g.openRevision!.id, { decision: second });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('NOT_AWAITING_REVIEW');
    expect(await rows('audit_events')).toBe(1);
    expect(await revisionStatus(g.openRevision!.id)).toBe(before.openRevision!.status);
  });

  it('refuses a revision that breaks no rule with 409 NOT_AWAITING_REVIEW', async () => {
    const t = await table();
    const g = await submitted(t, t.bo.caller, game(t, { requestOverride: true }));

    const res = await override(t, t.ana.caller, g.id, g.openRevision!.id, { decision: 'approve' });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('NOT_AWAITING_REVIEW');
    expect(await rows('audit_events')).toBe(0);
  });

  it('refuses a member who is not a commissioner with 403, even one who played', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);

    const res = await override(t, t.bo.caller, g.id, g.openRevision!.id, { decision: 'approve' });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('audit_events')).toBe(0);
  });

  it('refuses a commissioner demoted while the request waited with 403', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);
    let pending: Promise<Response> | undefined;

    // The request passes the role check it can make up front, then waits to re-read the
    // membership while Ana loses the role.
    await api.db.transaction(async (tx) => {
      await tx.execute(
        sql`update memberships set role = 'member' where id = ${t.ana.membershipId}`,
      );
      pending = override(t, t.ana.caller, g.id, g.openRevision!.id, { decision: 'approve' });
      await waitForLockWaiters(api.db, 1);
    });
    const res = await pending!;

    expect(res.status).toBe(403);
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('audit_events')).toBe(0);
  });

  it('refuses a revision whose window has closed with 409 WINDOW_CLOSED, so the game never counts', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);
    clock.advance(7 * DAY);

    const res = await override(t, t.ana.caller, g.id, g.openRevision!.id, { decision: 'approve' });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await countedRevision(g.id)).toBeNull();
    expect(await rows('audit_events')).toBe(0);
  });

  it('accepts a decision 1 s before the window closes', async () => {
    const t = await table();
    const g = await confirmedAwaitingReview(t);
    clock.advance(7 * DAY - SECOND);

    const after = await decided(t, g, 'approve');

    expect(after.status).toBe('confirmed');
  });

  it('refuses a superseded revision with 409 STALE_REVISION', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );

    const res = await override(t, t.ana.caller, g.id, g.openRevision!.id, { decision: 'approve' });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('STALE_REVISION');
    expect(await rows('audit_events')).toBe(0);
  });

  it.each([
    ['an unknown decision', { decision: 'maybe' }],
    ['no decision', {}],
    ['an unknown key', { decision: 'approve', reason: 'close enough' }],
  ])('rejects a body with %s with 422 VALIDATION', async (_label, body) => {
    const t = await table();
    const g = await sentForReview(t);

    const res = await override(t, t.ana.caller, g.id, g.openRevision!.id, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await rows('audit_events')).toBe(0);
  });

  it('gives 404 for a revision that belongs to a different game', async () => {
    const t = await table();
    const first = await sentForReview(t);
    const second = await sentForReview(t);

    const res = await override(t, t.ana.caller, first.id, second.openRevision!.id, {
      decision: 'approve',
    });

    expect(res.status).toBe(404);
    expect(await rows('audit_events')).toBe(0);
  });

  it("gives 404 to a commissioner of another league, even through their own league's path", async () => {
    const t = await table();
    const g = await sentForReview(t);
    const other = await league('Attic League', 'zed@example.com', 'Zed');

    const res = await override(other, other.commissioner, g.id, g.openRevision!.id, {
      decision: 'approve',
    });

    expect(res.status).toBe(404);
    expect(await rows('audit_events')).toBe(0);
  });

  it('accepts the game and revision ids in upper case', async () => {
    const t = await table();
    const g = await sentForReview(t);

    const res = await override(
      t,
      t.ana.caller,
      g.id.toUpperCase(),
      g.openRevision!.id.toUpperCase(),
      {
        decision: 'approve',
      },
    );

    expect(res.status).toBe(200);
    expect(GameResponse.parse(await res.json()).game.openRevision!.overrideStatus).toBe('approved');
  });

  it('replaces the counted revision once an approved correction of a reopened game confirms', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const counted = await confirmed(t, t.di.caller, g);
    const reopened = await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, counted, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );
    await confirmed(t, t.ana.caller, reopened);
    await confirmed(t, t.bo.caller, reopened);
    await confirmed(t, t.cy.caller, reopened);
    expect(await countedRevision(g.id)).toBe(counted.confirmedRevision!.id);

    const after = await decided(t, reopened, 'approve');

    expect(after).toMatchObject({
      status: 'confirmed',
      openRevision: null,
      confirmedRevision: { id: reopened.openRevision!.id, overrideStatus: 'approved' },
    });
    expect(await countedRevision(g.id)).toBe(reopened.openRevision!.id);
    expect(await revisionStatus(counted.confirmedRevision!.id)).toBe('superseded');
  });

  it('keeps the confirmed revision counting when a correction of a reopened game is rejected', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const counted = await confirmed(t, t.di.caller, g);
    const reopened = await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, counted, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );

    const after = await decided(t, reopened, 'reject');

    expect(after).toMatchObject({
      status: 'confirmed',
      openRevision: { id: reopened.openRevision!.id, status: 'rejected' },
      confirmedRevision: { id: counted.confirmedRevision!.id, status: 'confirmed' },
    });
    expect(await countedRevision(g.id)).toBe(counted.confirmedRevision!.id);
  });

  it('records one decision when two commissioners decide at once', async () => {
    const t = await table();
    await promoted(t, t.cy);
    const g = await confirmedAwaitingReview(t);
    const rid = g.openRevision!.id;

    const responses = await queuedOn(g.id, () => [
      override(t, t.ana.caller, g.id, rid, { decision: 'approve' }),
      override(t, t.cy.caller, g.id, rid, { decision: 'reject' }),
    ]);

    expect(responses.map((r) => r.status).toSorted()).toEqual([200, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect((await errorOf(loser)).code).toBe('NOT_AWAITING_REVIEW');
    expect(await rows('audit_events')).toBe(1);
  });

  it('confirms the game once when an approval races the last confirmation', async () => {
    const t = await table();
    const g = await sentForReview(t);
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const rid = g.openRevision!.id;

    const results = await raceOn(g.id, () => [
      override(t, t.ana.caller, g.id, rid, { decision: 'approve' }),
      confirm(t, t.di.caller, g.id, rid),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // Whichever ran second completed the revision, so it reports the game as counting.
    expect(results.map((r) => r.game.status).toSorted()).toEqual(['confirmed', 'pending']);
    expect(await countedRevision(g.id)).toBe(rid);
    expect(await rows('counted_results')).toBe(4);
    expect(await rows('audit_events')).toBe(1);
  });
});

describe('override request emails', () => {
  // A table whose setup mail is already sent and forgotten, with Ed as a second commissioner
  // who plays in none of these games.
  async function quietTable(): Promise<Table & { ed: Player }> {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    const res = await call('POST', `/api/leagues/${t.leagueId}/members/${ed.membershipId}/role`, {
      as: t.commissioner,
      body: { role: 'commissioner' },
    });
    expect(res.status).toBe(200);
    await drain();
    sent = [];
    return { ...t, ed };
  }

  const SUBJECT = 'A game is waiting for commissioner review';
  const reviewMail = () => sent.filter((m) => m.subject === SUBJECT);
  const recipients = () =>
    reviewMail()
      .map((m) => m.to[0]!.address)
      .toSorted();

  it('mails every commissioner when a game is sent for review, whether or not they played', async () => {
    const t = await quietTable();

    await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();

    expect(recipients()).toEqual(['ana@example.com', 'ed@example.com']);
  });

  it('names the author and links into the app, with no scores or ids', async () => {
    const t = await quietTable();

    await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    const stored = await api.db.execute<{ params: unknown }>(
      sql`select params from email_outbox where template = 'override_requested'`,
    );
    await drain();

    // Points, sinks, and every id contain digits; these display names and APP_ORIGIN don't.
    expect(stored).toHaveLength(2);
    for (const { params } of stored) expect(JSON.stringify(params)).not.toMatch(/\d/);
    for (const mail of reviewMail()) {
      expect(mail.text).toContain('Bo recorded a game that breaks the league rules');
      expect(mail.text).toContain(`${APP_ORIGIN}/overrides`);
      expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\d/);
      expect(mail.text).not.toContain('@');
    }
  });

  it('sends a commissioner who played one mail to confirm and one to review, and no more', async () => {
    const t = await quietTable();

    await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();

    const toAna = sent.filter((m) => m.to[0]!.address === 'ana@example.com');
    expect(toAna.map((m) => m.subject).toSorted()).toEqual([
      'A game is waiting for commissioner review',
      'A new game is waiting for your confirmation',
    ]);
  });

  it('does not mail the commissioner who sent their own game for review', async () => {
    const t = await quietTable();

    await submitted(t, t.ana.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();

    expect(recipients()).toEqual(['ed@example.com']);
  });

  it('mails the commissioners when a correction is sent for review', async () => {
    const t = await quietTable();
    const g = await submitted(t, t.bo.caller, game(t));
    await drain();
    sent = [];

    await corrected(
      t,
      t.di.caller,
      g.id,
      correction(t, g, { ...correctedMarginTooSmall(t), requestOverride: true }),
    );
    await drain();

    expect(recipients()).toEqual(['ana@example.com', 'ed@example.com']);
    for (const mail of reviewMail()) expect(mail.text).toContain('Di recorded a game');
  });

  it('does not mail a commissioner who opted out', async () => {
    const t = await quietTable();
    await api.db.execute(
      sql`update memberships set email_notifications = false where id = ${t.ed.membershipId}`,
    );

    await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();

    expect(recipients()).toEqual(['ana@example.com']);
  });

  it('does not mail the commissioners about a game that breaks no rule', async () => {
    const t = await quietTable();

    await submitted(t, t.bo.caller, game(t, { requestOverride: true }));
    await drain();

    expect(recipients()).toEqual([]);
  });

  it('does not mail the commissioners again when a submission sent for review is retried', async () => {
    const t = await quietTable();
    const body = marginTooSmall(t, { requestOverride: true });
    await submitted(t, t.bo.caller, body);

    const retry = await submit(t, t.bo.caller, body);
    await drain();

    expect(retry.status).toBe(200);
    expect(recipients()).toEqual(['ana@example.com', 'ed@example.com']);
  });

  it('does not mail anyone about a decision', async () => {
    const t = await quietTable();
    const g = await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();
    sent = [];

    await decided(t, g, 'approve');
    await drain();

    expect(sent).toEqual([]);
  });
});

describe('revision emails', () => {
  // A table whose setup mail (member-pending notes to Ana) is already sent and forgotten, so
  // a test sees only what its games enqueue.
  async function quietTable(): Promise<Table> {
    const t = await table();
    await drain();
    sent = [];
    return t;
  }

  const recipients = () => sent.map((m) => m.to[0]!.address).toSorted();

  it('mails the other three players, not the submitter, when a game is submitted', async () => {
    const t = await quietTable();

    await submitted(t, t.ana.caller, game(t));
    await drain();

    expect(recipients()).toEqual(['bo@example.com', 'cy@example.com', 'di@example.com']);
  });

  it('names the submitter and links to the inbox', async () => {
    const t = await quietTable();

    await submitted(t, t.ana.caller, game(t));
    await drain();

    const [mail] = sent;
    expect(mail!.subject).toBe('A new game is waiting for your confirmation');
    expect(mail!.text).toContain('Ana submitted a game with you.');
    expect(mail!.text).toContain(`${APP_ORIGIN}/inbox`);
  });

  it('mails the other players, naming the author, when a game is corrected', async () => {
    const t = await quietTable();
    const g = await submitted(t, t.ana.caller, game(t));
    await drain();
    sent = [];

    await corrected(t, t.bo.caller, g.id, correction(t, g));
    await drain();

    expect(recipients()).toEqual(['ana@example.com', 'cy@example.com', 'di@example.com']);
    for (const mail of sent) {
      expect(mail.subject).toBe('A corrected game is waiting for your confirmation');
      expect(mail.text).toContain('Bo corrected a game with you.');
    }
  });

  it('mails the other players, naming the author, when a confirmed game is reopened', async () => {
    const t = await quietTable();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    const c = await confirmed(t, t.di.caller, g);
    await drain();
    sent = [];

    await corrected(t, t.cy.caller, g.id, correction(t, c));
    await drain();

    expect(recipients()).toEqual(['ana@example.com', 'bo@example.com', 'di@example.com']);
    for (const mail of sent) {
      expect(mail.subject).toBe('A corrected game is waiting for your confirmation');
      expect(mail.text).toContain('Cy corrected a game with you.');
    }
  });

  it('never carries scores, ids, or email addresses, in the outbox or the mail', async () => {
    const t = await quietTable();

    await submitted(t, t.ana.caller, game(t));
    const stored = await api.db.execute<{ params: unknown }>(
      sql`select params from email_outbox where template = 'game_revision'`,
    );
    await drain();

    // Points, sinks, and every id contain digits; these display names and APP_ORIGIN don't.
    expect(stored).toHaveLength(3);
    for (const { params } of stored) expect(JSON.stringify(params)).not.toMatch(/\d/);
    expect(sent).toHaveLength(3);
    for (const mail of sent) {
      expect(`${mail.subject}\n${mail.text}`).not.toMatch(/\d/);
      expect(mail.text).not.toContain('@');
    }
  });

  it('does not mail a player who opted out', async () => {
    const t = await quietTable();
    await api.db.execute(
      sql`update memberships set email_notifications = false where id = ${t.cy.membershipId}`,
    );

    await submitted(t, t.ana.caller, game(t));
    await drain();

    expect(recipients()).toEqual(['bo@example.com', 'di@example.com']);
  });

  it('mails the other players about a game awaiting commissioner review', async () => {
    const t = await quietTable();

    await submitted(t, t.bo.caller, marginTooSmall(t, { requestOverride: true }));
    await drain();

    // Ana, a commissioner, is also asked to review it; that mail is covered on its own.
    const toConfirm = sent.filter(
      (m) => m.subject === 'A new game is waiting for your confirmation',
    );
    expect(toConfirm.map((m) => m.to[0]!.address).toSorted()).toEqual([
      'ana@example.com',
      'cy@example.com',
      'di@example.com',
    ]);
  });

  it('does not mail anyone again when a submission is retried', async () => {
    const t = await quietTable();
    const body = game(t);
    await submitted(t, t.ana.caller, body);

    const retry = await submit(t, t.ana.caller, body);
    await drain();

    expect(retry.status).toBe(200);
    expect(recipients()).toEqual(['bo@example.com', 'cy@example.com', 'di@example.com']);
  });

  it('never holds up a sign-in code behind a backlog of game mail', async () => {
    const t = await quietTable();
    // Seven games queue 21 notes, more than one drain sends, all older than the code.
    for (let i = 0; i < 7; i++) await submitted(t, t.ana.caller, game(t));
    clock.advance(SECOND);
    const res = await call('POST', '/api/auth/code', { body: { email: 'bo@example.com' } });
    expect(res.status).toBe(202);

    await drain();

    expect(sent.map((m) => m.subject)).toContain('Your Beer Die League sign-in code');
  });

  it('keeps game mail moving behind a flood of sign-in codes', async () => {
    const t = await quietTable();
    // A full batch of codes, all older than the game mail. Their params are blank, so the
    // drain drops them, but each still takes a place in the batch.
    await api.db.execute(sql`
      insert into email_outbox (user_id, template, params, next_attempt_at, created_at)
      select u.id, 'sign_in_code', '{}', ${NOW}, ${NOW}
      from users u cross join generate_series(1, 20)
      where u.email = 'cy@example.com'`);
    clock.advance(SECOND);
    await submitted(t, t.ana.caller, game(t));

    await drain();

    expect(recipients()).toEqual(['bo@example.com', 'cy@example.com', 'di@example.com']);
  });

  it('does not mail anyone about a refused submission', async () => {
    const t = await quietTable();

    const res = await submit(t, t.ana.caller, marginTooSmall(t));
    await drain();

    expect(res.status).toBe(422);
    expect(sent).toEqual([]);
  });
});

describe('the game write limit', () => {
  it(`refuses a member's submission past ${GAME_WRITES_PER_HOUR} game writes in an hour`, async () => {
    const t = await table();
    for (let i = 0; i < GAME_WRITES_PER_HOUR; i++) await submitted(t, t.ana.caller, game(t));

    const res = await submit(t, t.ana.caller, game(t));

    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('RATE_LIMITED');
  });

  it('counts corrections toward the same limit', async () => {
    const t = await table();
    let g = await submitted(t, t.ana.caller, game(t));
    for (let i = 1; i < GAME_WRITES_PER_HOUR; i++) {
      g = await corrected(t, t.ana.caller, g.id, correction(t, g));
    }

    const res = await correct(t, t.ana.caller, g.id, correction(t, g));

    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('RATE_LIMITED');
  });

  it('limits each member separately', async () => {
    const t = await table();
    for (let i = 0; i < GAME_WRITES_PER_HOUR; i++) await submitted(t, t.ana.caller, game(t));

    const res = await submit(t, t.bo.caller, game(t));

    expect(res.status).toBe(201);
  });

  it('lets a member record games again once the hour has passed', async () => {
    const t = await table();
    for (let i = 0; i < GAME_WRITES_PER_HOUR; i++) await submitted(t, t.ana.caller, game(t));
    clock.advance(HOUR);

    const res = await submit(t, t.ana.caller, game(t));

    expect(res.status).toBe(201);
  });

  it('queues no mail for a refused write', async () => {
    const t = await table();
    for (let i = 0; i < GAME_WRITES_PER_HOUR; i++) await submitted(t, t.ana.caller, game(t));
    const outbox = await rows('email_outbox');

    await submit(t, t.ana.caller, game(t));

    expect(await rows('email_outbox')).toBe(outbox);
    expect(await rows('games')).toBe(GAME_WRITES_PER_HOUR);
  });
});
