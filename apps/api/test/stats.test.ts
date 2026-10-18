import { randomUUID } from 'node:crypto';
import {
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  JoinResponse,
  pairKey,
  type PartnershipStats,
  PartnershipStatsResponse,
  PlayerStatResponse,
  type PlayerStats,
  PlayerStatsResponse,
  type SubmitGameBody,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-10-18T12:00:00.000Z';

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

const line = (p: Player, points: number, sinks = 0) => ({
  membershipId: p.membershipId,
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

async function submitted(t: League, as: Caller, body: SubmitGameBody): Promise<Game> {
  const res = await call('POST', `/api/leagues/${t.leagueId}/games`, { as, body });
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

function confirm(t: League, as: Caller, g: Game): Promise<Response> {
  return call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/confirm`,
    { as, body: {} },
  );
}

async function confirmed(t: League, as: Caller, g: Game): Promise<Game> {
  const res = await confirm(t, as, g);
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

// Submitted by the first side A player, then confirmed by the other three. `also` lists any
// players from outside the table.
async function counted(t: Table, body: SubmitGameBody, also: Player[] = []): Promise<Game> {
  const players = [t.ana, t.bo, t.cy, t.di, ...also];
  const lines = [...body.sides.A.players, ...body.sides.B.players];
  const [submitter, ...others] = lines.map((l) =>
    players.find((p) => p.membershipId === l.membershipId)!,
  );
  let g = await submitted(t, submitter!.caller, body);
  for (const p of others) g = await confirmed(t, p!.caller, g);
  expect(g.status).toBe('confirmed');
  return g;
}

function getStats(t: League, as: Caller, query: string): Promise<Response> {
  return call('GET', `/api/leagues/${t.leagueId}/stats/players${query}`, { as });
}

async function stats(t: League, as: Caller, scope: string): Promise<PlayerStats[]> {
  const res = await getStats(t, as, `?scope=${scope}`);
  expect(res.status).toBe(200);
  return PlayerStatsResponse.parse(await res.json()).players;
}

function getProfile(t: League, as: Caller, membershipId: string, query: string) {
  return call('GET', `/api/leagues/${t.leagueId}/stats/players/${membershipId}${query}`, { as });
}

async function profile(t: League, as: Caller, p: Player, scope: string): Promise<PlayerStats> {
  const res = await getProfile(t, as, p.membershipId, `?scope=${scope}`);
  expect(res.status).toBe(200);
  return PlayerStatResponse.parse(await res.json()).player;
}

function getPartnerships(t: League, as: Caller, query: string): Promise<Response> {
  return call('GET', `/api/leagues/${t.leagueId}/stats/partnerships${query}`, { as });
}

async function partnerships(t: League, as: Caller, scope: string): Promise<PartnershipStats[]> {
  const res = await getPartnerships(t, as, `?scope=${scope}`);
  expect(res.status).toBe(200);
  return PartnershipStatsResponse.parse(await res.json()).partnerships;
}

// A partnership's two players as the API lists them: in pairKey order.
function pair(a: Player, aName: string, b: Player, bName: string) {
  const players = [
    { membershipId: a.membershipId, displayName: aName },
    { membershipId: b.membershipId, displayName: bName },
  ];
  return pairKey(a.membershipId, b.membershipId).startsWith(a.membershipId)
    ? players
    : players.reverse();
}

const keyOf = (p: PartnershipStats) =>
  pairKey(p.players[0].membershipId, p.players[1].membershipId);

const names = (p: PartnershipStats) => p.players.map((x) => x.displayName).sort();

async function setStatus(p: Player, status: string): Promise<void> {
  await api.db.execute(sql`update memberships set status = ${status} where id = ${p.membershipId}`);
}

async function errorOf(res: Response) {
  return ErrorBody.parse(await res.json()).error;
}

const noGames = (p: Player, displayName: string): PlayerStats => ({
  membershipId: p.membershipId,
  displayName,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  winPct: null,
  points: 0,
  pointsPerGame: null,
  sinks: 0,
  sinksPerGame: null,
});

describe('player stats', () => {
  it('counts nothing while fewer than four players have confirmed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    expect(await stats(t, t.ana.caller, 'combined')).toEqual([]);
    expect(await profile(t, t.ana.caller, t.ana, 'combined')).toEqual(noGames(t.ana, 'Ana'));
  });

  it("counts the game's final line for each player once the fourth player confirms", async () => {
    const t = await table();
    const g = await submitted(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6, 1), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5, 2), line(t.di, 4)] },
        },
      }),
    );
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    await confirmed(t, t.di.caller, g);

    expect(await stats(t, t.bo.caller, 'combined')).toEqual([
      {
        membershipId: t.ana.membershipId,
        displayName: 'Ana',
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        winPct: 1,
        points: 6,
        pointsPerGame: 6,
        sinks: 1,
        sinksPerGame: 1,
      },
      {
        membershipId: t.bo.membershipId,
        displayName: 'Bo',
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        winPct: 1,
        points: 5,
        pointsPerGame: 5,
        sinks: 0,
        sinksPerGame: 0,
      },
      {
        membershipId: t.cy.membershipId,
        displayName: 'Cy',
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        winPct: 0,
        points: 5,
        pointsPerGame: 5,
        sinks: 2,
        sinksPerGame: 2,
      },
      {
        membershipId: t.di.membershipId,
        displayName: 'Di',
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        winPct: 0,
        points: 4,
        pointsPerGame: 4,
        sinks: 0,
        sinksPerGame: 0,
      },
    ]);
  });

  it('adds up games played, wins, losses, points, and sinks, with per-game rates', async () => {
    const t = await table();
    // Ana wins with 6 points, loses with 3 and a sink, then wins with 7 and two sinks.
    await counted(t, game(t));
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 3, 1), line(t.cy, 4)] },
          B: { players: [line(t.bo, 6), line(t.di, 5)] },
        },
        winner: 'B',
      }),
    );
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 7, 2), line(t.di, 4)] },
          B: { players: [line(t.bo, 4), line(t.cy, 5)] },
        },
      }),
    );

    expect(await profile(t, t.cy.caller, t.ana, 'combined')).toEqual({
      membershipId: t.ana.membershipId,
      displayName: 'Ana',
      gamesPlayed: 3,
      wins: 2,
      losses: 1,
      winPct: 2 / 3,
      points: 16,
      pointsPerGame: 16 / 3,
      sinks: 3,
      sinksPerGame: 1,
    });
  });

  it('ranks players by wins, then points, then name', async () => {
    const t = await table();
    // Joins last, so name order and join order disagree.
    const al = await member(t, 'al@example.com', 'Al');
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.bo, 6), line(al, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 4)] },
        },
      }),
      [al],
    );
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.bo, 6), line(t.ana, 5)] },
          B: { players: [line(t.di, 6), line(t.cy, 3)] },
        },
      }),
    );

    const listed = await stats(t, t.ana.caller, 'combined');

    // Al and Ana tie on wins and points; Di outscores both but has fewer wins.
    expect(listed.map((p) => [p.displayName, p.wins, p.points])).toEqual([
      ['Bo', 2, 12],
      ['Al', 1, 5],
      ['Ana', 1, 5],
      ['Di', 0, 10],
      ['Cy', 0, 8],
    ]);
  });

  it('leaves out members with no counted games in the scope', async () => {
    const t = await table();
    await member(t, 'ed@example.com', 'Ed');
    await counted(t, game(t));

    const listed = await stats(t, t.ana.caller, 'combined');

    expect(listed.map((p) => p.displayName)).toEqual(['Ana', 'Bo', 'Cy', 'Di']);
  });

  it('shows an exhibition game in exhibition and combined, but not in all-time', async () => {
    const t = await table();
    await counted(t, game(t));

    expect((await stats(t, t.ana.caller, 'exhibition')).map((p) => p.gamesPlayed)).toEqual([
      1, 1, 1, 1,
    ]);
    expect((await stats(t, t.ana.caller, 'combined')).map((p) => p.gamesPlayed)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(await stats(t, t.ana.caller, 'alltime')).toEqual([]);
    expect(await profile(t, t.ana.caller, t.ana, 'alltime')).toEqual(noGames(t.ana, 'Ana'));
  });

  it('never counts a game whose window closed before the fourth confirmation', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    clock.advance(7 * DAY);

    const late = await confirm(t, t.di.caller, g);

    expect(late.status).toBe(409);
    expect(await stats(t, t.ana.caller, 'combined')).toEqual([]);
  });

  it('keeps a rule-breaking game out while its commissioner review is pending', async () => {
    const t = await table();
    // 11–10 is one point short of the default win-by.
    const g = await submitted(
      t,
      t.ana.caller,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 5)] },
        },
        requestOverride: true,
      }),
    );
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);
    await confirmed(t, t.di.caller, g);

    expect(await stats(t, t.ana.caller, 'combined')).toEqual([]);
  });

  // Defence in depth: only the code that confirms a revision sets confirmed_revision_id.
  it('never counts a revision under a game it does not belong to', async () => {
    const t = await table();
    const first = await counted(t, game(t));
    const second = await counted(t, game(t));
    await api.db.execute(
      sql`update games set confirmed_revision_id = ${first.confirmedRevision!.id}
          where id = ${second.id}`,
    );

    expect((await stats(t, t.ana.caller, 'combined')).map((p) => p.gamesPlayed)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('counts a game once when the last two confirmations race', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);

    let racing: Promise<Response[]> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from games where id = ${g.id} for update`);
      racing = Promise.all([confirm(t, t.cy.caller, g), confirm(t, t.di.caller, g)]);
      await waitForLockWaiters(api.db, 2);
    });
    expect((await racing!).map((r) => r.status)).toEqual([200, 200]);

    expect((await stats(t, t.ana.caller, 'combined')).map((p) => p.gamesPlayed)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('lets a member who did not play read the stats', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    await counted(t, game(t));

    expect(await stats(t, ed.caller, 'combined')).toHaveLength(4);
    expect(await profile(t, ed.caller, t.cy, 'combined')).toMatchObject({ gamesPlayed: 1 });
  });

  it("counts only this league's games for a player in two leagues", async () => {
    const x = await table();
    const { self: yan, ...l } = await league('Garage League', 'yan@example.com', 'Yan');
    const y: Table = {
      ...l,
      ana: yan,
      bo: await member(l, 'bo@example.com', 'Bo'),
      cy: await member(l, 'pat@example.com', 'Pat'),
      di: await member(l, 'quinn@example.com', 'Quinn'),
    };
    await counted(x, game(x));
    await counted(y, game(y));
    await counted(y, game(y));

    const inX = await stats(x, x.bo.caller, 'combined');
    const inY = await stats(y, y.bo.caller, 'combined');

    expect(inX.map((p) => [p.displayName, p.gamesPlayed])).toEqual([
      ['Ana', 1],
      ['Bo', 1],
      ['Cy', 1],
      ['Di', 1],
    ]);
    expect(inY.map((p) => [p.displayName, p.gamesPlayed])).toEqual([
      ['Yan', 2],
      ['Bo', 2],
      ['Pat', 2],
      ['Quinn', 2],
    ]);
    expect(await profile(x, x.bo.caller, x.bo, 'combined')).toMatchObject({ gamesPlayed: 1 });
  });

  it.each([
    ['no scope', ''],
    ['an unknown scope', '?scope=lifetime'],
    ['a season scope, which arrives with seasons', `?scope=season:${randomUUID()}`],
    ['an unknown parameter', '?scope=combined&sort=wins'],
  ])('rejects %s with 422 VALIDATION', async (_label, query) => {
    const t = await table();

    const list = await getStats(t, t.bo.caller, query);
    const one = await getProfile(t, t.bo.caller, t.ana.membershipId, query);

    expect([list.status, one.status]).toEqual([422, 422]);
    expect((await errorOf(list)).code).toBe('VALIDATION');
    expect((await errorOf(one)).code).toBe('VALIDATION');
  });
});

describe("a player's profile", () => {
  it('gives zeros to an approved member with no counted games', async () => {
    const t = await table();
    const ed = await member(t, 'ed@example.com', 'Ed');
    await counted(t, game(t));

    expect(await profile(t, t.ana.caller, ed, 'combined')).toEqual(noGames(ed, 'Ed'));
  });

  it("accepts the member's id in upper case", async () => {
    const t = await table();
    await counted(t, game(t));

    const res = await getProfile(
      t,
      t.bo.caller,
      t.cy.membershipId.toUpperCase(),
      '?scope=combined',
    );

    expect(res.status).toBe(200);
    expect(PlayerStatResponse.parse(await res.json()).player).toMatchObject({
      membershipId: t.cy.membershipId,
      gamesPlayed: 1,
    });
  });

  // A pending member isn't in the league yet, and only commissioners may see that they asked.
  it('gives 404 for a member awaiting approval, even to a commissioner', async () => {
    const t = await table();
    const pat = await member(t, 'pat@example.com', 'Pat', false);

    const res = await getProfile(t, t.ana.caller, pat.membershipId, '?scope=combined');

    expect(res.status).toBe(404);
  });

  // Removal, leaving, and account deletion arrive in slice 7; the status is set directly here.
  it.each(['removed', 'left', 'deleted'])(
    'gives 404 for a %s member with no counted games',
    async (status) => {
      const t = await table();
      const ed = await member(t, 'ed@example.com', 'Ed');
      await setStatus(ed, status);

      const res = await getProfile(t, t.bo.caller, ed.membershipId, '?scope=combined');

      expect(res.status).toBe(404);
    },
  );

  it('keeps the profile of a former member whose games still count, in every scope', async () => {
    const t = await table();
    await counted(t, game(t));
    await setStatus(t.cy, 'left');

    expect(await profile(t, t.bo.caller, t.cy, 'combined')).toMatchObject({ gamesPlayed: 1 });
    expect(await profile(t, t.bo.caller, t.cy, 'alltime')).toEqual(noGames(t.cy, 'Cy'));
  });

  it('gives 404 for a member of another league', async () => {
    const x = await table();
    const { self: yan } = await league('Garage League', 'yan@example.com', 'Yan');

    const res = await getProfile(x, x.ana.caller, yan.membershipId, '?scope=combined');

    expect(res.status).toBe(404);
  });

  it.each([
    ['an unknown id', randomUUID()],
    ['an id that is not a UUID', 'not-a-uuid'],
  ])('gives 404 for %s', async (_label, membershipId) => {
    const t = await table();

    const res = await getProfile(t, t.ana.caller, membershipId, '?scope=combined');

    expect(res.status).toBe(404);
  });
});

describe('partnership stats', () => {
  it('counts nothing while fewer than four players have confirmed', async () => {
    const t = await table();
    const g = await submitted(t, t.ana.caller, game(t));
    await confirmed(t, t.bo.caller, g);
    await confirmed(t, t.cy.caller, g);

    expect(await partnerships(t, t.ana.caller, 'combined')).toEqual([]);
  });

  it("credits each side's pair with the result and the pair's combined points and sinks", async () => {
    const t = await table();
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6, 1), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5, 1), line(t.di, 4, 1)] },
        },
      }),
    );

    expect(await partnerships(t, t.bo.caller, 'combined')).toEqual([
      {
        players: pair(t.ana, 'Ana', t.bo, 'Bo'),
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        winPct: 1,
        points: 11,
        sinks: 1,
      },
      {
        players: pair(t.cy, 'Cy', t.di, 'Di'),
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        winPct: 0,
        points: 9,
        sinks: 2,
      },
    ]);
  });

  it("adds up a pair's games played, wins, losses, points, and sinks", async () => {
    const t = await table();
    // Ana and Bo win 11–9, lose 9–11 with a sink each, then win 13–11 with two sinks.
    await counted(t, game(t));
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 5, 1), line(t.bo, 4, 1)] },
          B: { players: [line(t.cy, 6), line(t.di, 5)] },
        },
        winner: 'B',
      }),
    );
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 7, 2), line(t.bo, 6)] },
          B: { players: [line(t.cy, 6), line(t.di, 5)] },
        },
      }),
    );

    const [anaAndBo] = await partnerships(t, t.cy.caller, 'combined');

    expect(anaAndBo).toEqual({
      players: pair(t.ana, 'Ana', t.bo, 'Bo'),
      gamesPlayed: 3,
      wins: 2,
      losses: 1,
      winPct: 2 / 3,
      points: 33,
      sinks: 4,
    });
  });

  it('treats two players as one partnership whichever of them is listed first', async () => {
    const t = await table();
    await counted(t, game(t));
    // Bo first on side A, then the pair on side B.
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.bo, 6), line(t.ana, 5)] },
          B: { players: [line(t.di, 5), line(t.cy, 4)] },
        },
      }),
    );
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.cy, 6), line(t.di, 5)] },
          B: { players: [line(t.bo, 5), line(t.ana, 4)] },
        },
      }),
    );

    const listed = await partnerships(t, t.ana.caller, 'combined');

    expect(listed.map((p) => [keyOf(p), p.gamesPlayed])).toEqual([
      [pairKey(t.ana.membershipId, t.bo.membershipId), 3],
      [pairKey(t.cy.membershipId, t.di.membershipId), 3],
    ]);
  });

  it("lists each pair's players in pairKey order", async () => {
    const t = await table();
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.bo, 6), line(t.ana, 5)] },
          B: { players: [line(t.di, 5), line(t.cy, 4)] },
        },
      }),
    );

    const listed = await partnerships(t, t.ana.caller, 'combined');

    expect(listed.map((p) => p.players.map((x) => x.membershipId).join(':'))).toEqual(
      listed.map(keyOf),
    );
  });

  // The pair is whoever was on the same side in the confirmed result (SPEC §3.7); opponents
  // in one game are partners only in the games where they played together.
  it('credits a pair only with the games its players played on the same side', async () => {
    const t = await table();
    await counted(t, game(t));
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.cy, 5)] },
          B: { players: [line(t.bo, 5), line(t.di, 4)] },
        },
      }),
    );

    const listed = await partnerships(t, t.ana.caller, 'combined');

    expect(listed.map((p) => [names(p), p.gamesPlayed, p.wins])).toEqual([
      [['Ana', 'Bo'], 1, 1],
      [['Ana', 'Cy'], 1, 1],
      [['Bo', 'Di'], 1, 0],
      [['Cy', 'Di'], 1, 0],
    ]);
  });

  it('ranks partnerships by wins, then points, then names', async () => {
    const t = await table();
    // Joins last, so name order and join order disagree.
    const al = await member(t, 'al@example.com', 'Al');
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(t.bo, 6), line(t.cy, 5)] },
          B: { players: [line(al, 5), line(t.di, 4)] },
        },
      }),
      [al],
    );
    await counted(
      t,
      game(t, {
        sides: {
          A: { players: [line(al, 6), line(t.di, 5)] },
          B: { players: [line(t.bo, 5), line(t.cy, 4)] },
        },
      }),
      [al],
    );
    for (let i = 0; i < 2; i++) {
      await counted(
        t,
        game(t, {
          sides: {
            A: { players: [line(t.ana, 7), line(t.bo, 6)] },
            B: { players: [line(t.cy, 6), line(t.di, 5)] },
          },
        }),
      );
    }

    const listed = await partnerships(t, t.ana.caller, 'combined');

    // Al and Di tie Bo and Cy on wins and points; Cy and Di outscore both but never win.
    expect(listed.map((p) => [names(p), p.wins, p.points])).toEqual([
      [['Ana', 'Bo'], 2, 26],
      [['Al', 'Di'], 1, 20],
      [['Bo', 'Cy'], 1, 20],
      [['Cy', 'Di'], 0, 22],
    ]);
  });

  it('shows an exhibition game in exhibition and combined, but not in all-time', async () => {
    const t = await table();
    await counted(t, game(t));

    expect((await partnerships(t, t.ana.caller, 'exhibition')).map(names)).toEqual([
      ['Ana', 'Bo'],
      ['Cy', 'Di'],
    ]);
    expect((await partnerships(t, t.ana.caller, 'combined')).map(names)).toEqual([
      ['Ana', 'Bo'],
      ['Cy', 'Di'],
    ]);
    expect(await partnerships(t, t.ana.caller, 'alltime')).toEqual([]);
  });

  it('keeps the partnerships of a former member whose games still count', async () => {
    const t = await table();
    await counted(t, game(t));
    await setStatus(t.cy, 'left');

    expect((await partnerships(t, t.bo.caller, 'combined')).map(names)).toEqual([
      ['Ana', 'Bo'],
      ['Cy', 'Di'],
    ]);
  });

  it("counts only this league's games for players in two leagues", async () => {
    const x = await table();
    // Cy and Di partner in both leagues, as different memberships.
    const { self: yan, ...l } = await league('Garage League', 'yan@example.com', 'Yan');
    const y: Table = {
      ...l,
      ana: yan,
      bo: await member(l, 'bo@example.com', 'Bo'),
      cy: await member(l, 'cy@example.com', 'Cy'),
      di: await member(l, 'di@example.com', 'Di'),
    };
    await counted(x, game(x));
    await counted(y, game(y));
    await counted(y, game(y));

    const inX = await partnerships(x, x.bo.caller, 'combined');
    const inY = await partnerships(y, y.bo.caller, 'combined');

    expect(inX.map((p) => [names(p), p.gamesPlayed])).toEqual([
      [['Ana', 'Bo'], 1],
      [['Cy', 'Di'], 1],
    ]);
    expect(inY.map((p) => [names(p), p.gamesPlayed])).toEqual([
      [['Bo', 'Yan'], 2],
      [['Cy', 'Di'], 2],
    ]);
  });

  it.each([
    ['no scope', ''],
    ['an unknown scope', '?scope=lifetime'],
    ['a season scope, which arrives with seasons', `?scope=season:${randomUUID()}`],
    ['an unknown parameter', '?scope=combined&sort=wins'],
  ])('rejects %s with 422 VALIDATION', async (_label, query) => {
    const t = await table();

    const res = await getPartnerships(t, t.bo.caller, query);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });
});
