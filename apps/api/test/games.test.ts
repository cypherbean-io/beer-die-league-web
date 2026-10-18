import { randomUUID } from 'node:crypto';
import {
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  JoinResponse,
  type SubmitGameBody,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const NOW = '2026-10-18T12:00:00.000Z';
const DEFAULT_RULES = { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false };

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;
let call: ReturnType<typeof client>;

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  clock = new FixedClock(NOW);
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
function game(t: Table, patch: Partial<SubmitGameBody> = {}): SubmitGameBody {
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
function marginTooSmall(t: Table, patch: Partial<SubmitGameBody> = {}): SubmitGameBody {
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

async function rows(table: 'games' | 'game_revisions' | 'revision_players' | 'confirmations') {
  const [row] = await api.db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return row!.n;
}

function patchLeague(t: League, what: 'rules' | 'settings', body: unknown) {
  return call('PATCH', `/api/leagues/${t.leagueId}/${what}`, { as: t.commissioner, body });
}

describe('submitting an exhibition game', () => {
  it("opens revision 1 with the four player lines and the submitter's confirmation", async () => {
    const t = await table();

    const recorded = await submitted(t, t.ana.caller, game(t));

    expect(recorded).toEqual({
      id: expect.any(String),
      kind: 'exhibition',
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
    ['a season game, which needs seasons', (t) => ({ ...game(t), kind: 'season' })],
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
