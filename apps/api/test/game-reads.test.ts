import { randomUUID } from 'node:crypto';
import {
  type CorrectGameBody,
  CreateInviteResponse,
  ErrorBody,
  type ExhibitionGameBody,
  type Game,
  GameDetailResponse,
  GameResponse,
  GamesResponse,
  JoinResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const NOW = '2026-10-18T12:00:00.000Z';
const WINDOW = 7 * DAY;

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
// Ana is the commissioner; Bo, Cy, and Di play with her; Ed is a member who doesn't play.
type Table = League & { ana: Player; bo: Player; cy: Player; di: Player; ed: Player };

async function league(name: string, email: string, displayName: string) {
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName,
  });
  const caller = await signIn(api.db, clock, email);
  return { leagueId, commissioner: caller, self: { caller, membershipId } };
}

async function member(l: League, email: string, displayName: string): Promise<Player> {
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
  const approved = await call(
    'POST',
    `/api/leagues/${l.leagueId}/members/${membershipId}/approve`,
    { as: l.commissioner, body: {} },
  );
  expect(approved.status).toBe(200);
  return { caller, membershipId };
}

async function table(name = 'Basement League', domain = 'example.com'): Promise<Table> {
  const { self: ana, ...l } = await league(name, `ana@${domain}`, 'Ana');
  return {
    ...l,
    ana,
    bo: await member(l, `bo@${domain}`, 'Bo'),
    cy: await member(l, `cy@${domain}`, 'Cy'),
    di: await member(l, `di@${domain}`, 'Di'),
    ed: await member(l, `ed@${domain}`, 'Ed'),
  };
}

const line = (p: Player, points: number) => ({ membershipId: p.membershipId, points, sinks: 0 });

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

// Ana and Bo win 11–10, one point short of the default win-by, sent for review.
function forReview(t: Table): ExhibitionGameBody {
  return game(t, {
    sides: {
      A: { players: [line(t.ana, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 5)] },
    },
    requestOverride: true,
  });
}

async function submitted(t: League, as: Caller, body: unknown): Promise<Game> {
  const res = await call('POST', `/api/leagues/${t.leagueId}/games`, { as, body });
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

async function confirmed(t: League, as: Caller, g: Game): Promise<Game> {
  const res = await call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/confirm`,
    { as, body: {} },
  );
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

async function counted(t: Table, body: ExhibitionGameBody): Promise<Game> {
  let g = await submitted(t, t.ana.caller, body);
  for (const p of [t.bo, t.cy, t.di]) g = await confirmed(t, p.caller, g);
  expect(g.status).toBe('confirmed');
  return g;
}

// Di's 4 points fixed to 3.
function correction(t: Table, g: Game): CorrectGameBody {
  return {
    baseRevisionId: (g.openRevision ?? g.confirmedRevision)!.id,
    playedAt: '2026-10-18T11:30:00.000Z',
    sides: {
      A: { players: [line(t.ana, 6), line(t.bo, 5)] },
      B: { players: [line(t.cy, 5), line(t.di, 3)] },
    },
    winner: 'A',
  };
}

async function corrected(t: League, as: Caller, g: Game, body: CorrectGameBody): Promise<Game> {
  const res = await call('POST', `/api/leagues/${t.leagueId}/games/${g.id}/revisions`, {
    as,
    body,
  });
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

function listGames(t: League, as: Caller, query = ''): Promise<Response> {
  return call('GET', `/api/leagues/${t.leagueId}/games${query}`, { as });
}

async function gamesPage(t: League, as: Caller, query = ''): Promise<GamesResponse> {
  const res = await listGames(t, as, query);
  expect(res.status).toBe(200);
  return GamesResponse.parse(await res.json());
}

function getGame(t: League, as: Caller, gameId: string): Promise<Response> {
  return call('GET', `/api/leagues/${t.leagueId}/games/${gameId}`, { as });
}

async function detail(t: League, as: Caller, gameId: string): Promise<GameDetailResponse> {
  const res = await getGame(t, as, gameId);
  expect(res.status).toBe(200);
  return GameDetailResponse.parse(await res.json());
}

async function storedStatus(gameId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from games where id = ${gameId}`,
  );
  return row!.status;
}

describe('GET /games', () => {
  it("lists the league's games newest first to any member, players or not", async () => {
    const t = await table();
    const first = await submitted(t, t.ana.caller, game(t));
    const second = await counted(t, game(t));
    const third = await submitted(t, t.cy.caller, game(t));

    const page = await gamesPage(t, t.ed.caller);

    expect(page.games.map((g) => g.id)).toEqual([third.id, second.id, first.id]);
    expect(page.games[1]).toEqual(second);
    expect(page.nextBefore).toBeNull();
  });

  it('pages backwards with a before cursor', async () => {
    const t = await table();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await submitted(t, t.ana.caller, game(t))).id);

    const first = await gamesPage(t, t.bo.caller, '?limit=2');
    const second = await gamesPage(t, t.bo.caller, `?limit=2&before=${first.nextBefore}`);

    expect(first.games.map((g) => g.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextBefore).toBe(ids[1]);
    expect(second.games.map((g) => g.id)).toEqual([ids[0]]);
    expect(second.nextBefore).toBeNull();
  });

  it('shows a game whose window has lapsed as expired before anything settles it', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(WINDOW);

    const [listed] = (await gamesPage(t, t.bo.caller)).games;

    expect(listed).toMatchObject({
      id: g.id,
      status: 'expired',
      windowExpiresAt: null,
      openRevision: null,
      confirmedRevision: null,
    });
    expect(await storedStatus(g.id)).toBe('pending');
  });

  it('shows the game as still pending a second before its window closes', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(WINDOW - SECOND);

    const [listed] = (await gamesPage(t, t.bo.caller)).games;

    expect(listed).toEqual(g);
  });

  it('shows a reopened game whose correction lapsed as confirmed, as it was', async () => {
    const t = await table();
    const g = await counted(t, game(t));
    await corrected(t, t.cy.caller, g, correction(t, g));
    clock.advance(WINDOW);

    const [listed] = (await gamesPage(t, t.bo.caller)).games;

    expect(listed).toEqual({ ...g, windowExpiresAt: null, openRevision: null });
  });

  it('lists only games awaiting a commissioner review with awaiting=override', async () => {
    const t = await table();
    await submitted(t, t.ana.caller, game(t));
    const review = await submitted(t, t.ana.caller, forReview(t));
    const lapsed = await submitted(t, t.bo.caller, forReview(t));
    await api.db.execute(
      sql`update games set window_expires_at = ${clock.now().toISOString()}::timestamptz where id = ${lapsed.id}`,
    );

    const page = await gamesPage(t, t.commissioner, '?awaiting=override');

    expect(page.games.map((g) => g.id)).toEqual([review.id]);
  });

  it('drops a game from the review queue once a commissioner decides it', async () => {
    const t = await table();
    const review = await submitted(t, t.ana.caller, forReview(t));
    const res = await call(
      'POST',
      `/api/leagues/${t.leagueId}/games/${review.id}/revisions/${review.openRevision!.id}/override`,
      { as: t.commissioner, body: { decision: 'reject' } },
    );
    expect(res.status).toBe(200);

    expect((await gamesPage(t, t.commissioner, '?awaiting=override')).games).toEqual([]);
  });

  it("never lists another league's games", async () => {
    const t = await table();
    const other = await table('Attic League', 'attic.example.com');
    const mine = await submitted(t, t.ana.caller, game(t));
    await submitted(other, other.ana.caller, game(other));

    expect((await gamesPage(t, t.bo.caller)).games.map((g) => g.id)).toEqual([mine.id]);
  });

  it.each([
    ['a limit of 0', '?limit=0'],
    ['a limit over the page size', '?limit=51'],
    ['a limit that is not a whole number', '?limit=1e2'],
    ['a malformed cursor', '?before=nope'],
    ['an unknown filter', '?awaiting=confirmation'],
    ['an unknown parameter', '?sort=oldest'],
  ])('refuses %s with 422 VALIDATION', async (_label, query) => {
    const t = await table();

    const res = await listGames(t, t.bo.caller, query);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });
});

describe('GET /games/:gid', () => {
  it('returns every revision oldest first, with who confirmed each and when it was made', async () => {
    const t = await table();
    let g = await submitted(t, t.ana.caller, game(t));
    g = await confirmed(t, t.bo.caller, g);
    clock.advance(HOUR);
    g = await corrected(t, t.cy.caller, g, correction(t, g));

    const { game: shown, revisions } = await detail(t, t.ed.caller, g.id);

    expect(shown).toEqual(g);
    expect(revisions.map((r) => [r.number, r.status, r.createdAt])).toEqual([
      [1, 'superseded', NOW],
      [2, 'open', '2026-10-18T13:00:00.000Z'],
    ]);
    expect(revisions[0]!.players.map((p) => [p.displayName, p.points, p.confirmation])).toEqual([
      ['Ana', 6, 'player'],
      ['Bo', 5, 'player'],
      ['Cy', 5, null],
      ['Di', 4, null],
    ]);
    expect(revisions[1]).toMatchObject({
      ...g.openRevision,
      createdAt: '2026-10-18T13:00:00.000Z',
    });
  });

  it("includes the game's log entries, flagging a commissioner who played", async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    const other = await submitted(t, t.ana.caller, game(t));
    for (const target of [g, other]) {
      const res = await call(
        'POST',
        `/api/leagues/${t.leagueId}/games/${target.id}/revisions/${target.openRevision!.id}/force-confirm`,
        { as: t.commissioner, body: { membershipIds: [t.cy.membershipId] } },
      );
      expect(res.status).toBe(200);
    }

    const { audit } = await detail(t, t.bo.caller, g.id);

    expect(audit).toEqual([
      expect.objectContaining({
        action: 'game.confirmation_forced',
        targetId: g.id,
        actorWasParticipant: true,
        actor: { membershipId: t.ana.membershipId, displayName: 'Ana' },
        player: { membershipId: t.cy.membershipId, displayName: 'Cy' },
        details: { revisionId: g.openRevision!.id, membershipId: t.cy.membershipId },
      }),
    ]);
  });

  it('shows a lapsed open revision as expired in the history', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    clock.advance(WINDOW);

    const shown = await detail(t, t.bo.caller, g.id);

    expect(shown.game).toMatchObject({ status: 'expired', openRevision: null });
    expect(shown.revisions.map((r) => r.status)).toEqual(['expired']);
  });

  it("gives 404 for another league's game, exactly as for an unknown one", async () => {
    const t = await table();
    const other = await table('Attic League', 'attic.example.com');
    const theirs = await submitted(other, other.ana.caller, game(other));

    for (const id of [theirs.id, randomUUID()]) {
      const res = await getGame(t, t.bo.caller, id);
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('NOT_FOUND');
    }
  });
});
