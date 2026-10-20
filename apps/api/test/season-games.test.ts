import { randomUUID } from 'node:crypto';
import {
  type CorrectGameBody,
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  JoinResponse,
  PlayerStatsResponse,
  type Season,
  type SeasonGameBody,
  SeasonResponse,
  type Team,
  TeamResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
// The league is set up and its season started a day before the games are played.
const START = '2026-10-17T12:00:00.000Z';
const NOW = '2026-10-18T12:00:00.000Z';
const PLAYED_AT = '2026-10-18T11:30:00.000Z';

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
  clock = new FixedClock(START);
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

async function rows(table: 'games' | 'game_revisions'): Promise<number> {
  const [row] = await api.db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return row!.n;
}

// Moves the clock forward to `iso`, or leaves it if it is already there.
function at(iso: string): void {
  clock.advance(Date.parse(iso) - clock.now().getTime());
}

type Player = { caller: Caller; membershipId: string };
type League = { leagueId: string; commissioner: Caller };
// Ana is the commissioner. In the active Fall season Ana and Bo are the Sharks, Cy and Di the
// Jets, and Flo and Gus the Owls. Ed and Hal are on no team.
type Setup = League & {
  ana: Player;
  bo: Player;
  cy: Player;
  di: Player;
  ed: Player;
  flo: Player;
  gus: Player;
  hal: Player;
  season: Season;
  sharks: Team;
  jets: Team;
  owls: Team;
};

// A signed-in, approved member admitted through the real invite flow.
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

const seasonsPath = (l: League) => `/api/leagues/${l.leagueId}/seasons`;

async function seasonOf(res: Response): Promise<Season> {
  expect(res.status).toBe(200);
  return SeasonResponse.parse(await res.json()).season;
}

async function draft(l: League, name: string): Promise<Season> {
  const res = await call('POST', seasonsPath(l), { as: l.commissioner, body: { name } });
  expect(res.status).toBe(201);
  return SeasonResponse.parse(await res.json()).season;
}

async function started(l: League, seasonId: string): Promise<Season> {
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${seasonId}/start`, { as: l.commissioner, body: {} }),
  );
}

async function ended(l: League, seasonId: string): Promise<Season> {
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${seasonId}/end`, { as: l.commissioner, body: {} }),
  );
}

function act(l: League, as: Caller, teamId: string, action: 'accept' | 'approve') {
  return call('POST', `/api/leagues/${l.leagueId}/teams/${teamId}/${action}`, { as, body: {} });
}

async function proposed(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name: string,
): Promise<Team> {
  const res = await call('POST', `${seasonsPath(l)}/${seasonId}/teams`, {
    as: proposer.caller,
    body: { name, partnerId: partner.membershipId },
  });
  expect(res.status).toBe(201);
  return TeamResponse.parse(await res.json()).team;
}

// Proposed, accepted by the partner, and approved by the commissioner.
async function approved(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name: string,
): Promise<Team> {
  const team = await proposed(l, proposer, partner, seasonId, name);
  expect((await act(l, partner.caller, team.id, 'accept')).status).toBe(200);
  const res = await act(l, l.commissioner, team.id, 'approve');
  expect(res.status).toBe(200);
  return TeamResponse.parse(await res.json()).team;
}

// Builds the league at START, then moves the clock to NOW.
async function setup(name = 'Basement League', domain = 'example.com'): Promise<Setup> {
  const email = `ana@${domain}`;
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName: 'Ana',
  });
  const caller = await signIn(api.db, clock, email);
  const l = { leagueId, commissioner: caller };
  const ana = { caller, membershipId };
  const players = {
    bo: await member(l, `bo@${domain}`, 'Bo'),
    cy: await member(l, `cy@${domain}`, 'Cy'),
    di: await member(l, `di@${domain}`, 'Di'),
    ed: await member(l, `ed@${domain}`, 'Ed'),
    flo: await member(l, `flo@${domain}`, 'Flo'),
    gus: await member(l, `gus@${domain}`, 'Gus'),
    hal: await member(l, `hal@${domain}`, 'Hal'),
  };
  const season = await started(l, (await draft(l, 'Fall 2026')).id);
  const sharks = await approved(l, ana, players.bo, season.id, 'Sharks');
  const jets = await approved(l, players.cy, players.di, season.id, 'Jets');
  const owls = await approved(l, players.flo, players.gus, season.id, 'Owls');
  at(NOW);
  return { ...l, ana, ...players, season, sharks, jets, owls };
}

type Line = { membershipId: string; points: number; sinks: number };

const line = (p: Player, points: number): Line => ({
  membershipId: p.membershipId,
  points,
  sinks: 0,
});

const side = (team: Team, a: Line, b: Line) => ({ teamId: team.id, players: [a, b] });

// The Sharks (Ana and Bo) beat the Jets (Cy and Di) 11–9, half an hour ago.
function seasonGame(s: Setup, patch: Partial<SeasonGameBody> = {}): SeasonGameBody {
  return {
    idempotencyKey: randomUUID(),
    kind: 'season',
    seasonId: s.season.id,
    playedAt: PLAYED_AT,
    sides: {
      A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
      B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
    },
    winner: 'A',
    ...patch,
  };
}

function submit(l: League, as: Player, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/games`, { as: as.caller, body });
}

async function submitted(l: League, as: Player, body: SeasonGameBody): Promise<Game> {
  const res = await submit(l, as, body);
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

async function confirmed(l: League, as: Player, g: Game): Promise<Game> {
  const res = await call(
    'POST',
    `/api/leagues/${l.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/confirm`,
    { as: as.caller, body: {} },
  );
  expect(res.status).toBe(200);
  return GameResponse.parse(await res.json()).game;
}

// Submitted by `by`, then confirmed by the other three.
async function counted(s: Setup, by: Player, body: SeasonGameBody): Promise<Game> {
  const everyone = [s.ana, s.bo, s.cy, s.di, s.ed, s.flo, s.gus, s.hal];
  const ids = [...body.sides.A.players, ...body.sides.B.players].map((p) => p.membershipId);
  let g = await submitted(s, by, body);
  for (const p of everyone) {
    if (p !== by && ids.includes(p.membershipId)) g = await confirmed(s, p, g);
  }
  expect(g.status).toBe('confirmed');
  return g;
}

// A correction carries the players and numbers, never the teams.
function correction(
  base: string,
  A: [Line, Line],
  B: [Line, Line],
  patch: Partial<CorrectGameBody> = {},
): CorrectGameBody {
  return {
    baseRevisionId: base,
    playedAt: PLAYED_AT,
    sides: { A: { players: A }, B: { players: B } },
    winner: 'A',
    ...patch,
  };
}

function correct(l: League, as: Player, g: Game, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/games/${g.id}/revisions`, {
    as: as.caller,
    body,
  });
}

async function corrected(l: League, as: Player, g: Game, body: CorrectGameBody): Promise<Game> {
  const res = await correct(l, as, g, body);
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

const teamsOf = (...teams: [Team, Team]) => ({
  A: { id: teams[0].id, name: teams[0].name },
  B: { id: teams[1].id, name: teams[1].name },
});

const subs = (g: Game) =>
  g.openRevision!.players.map((p) => [p.displayName, p.side, p.isSub] as const);

// Ends the season in a transaction that holds its row lock, as endSeason does, while
// `request` runs; the request must wait for it before it can see the season.
async function whileEnding(seasonId: string, request: () => Promise<Response>) {
  let pending: Promise<Response> | undefined;
  await api.db.transaction(async (tx) => {
    await tx.execute(sql`update seasons set status = 'ended', ended_at = ${NOW}::timestamptz
                         where id = ${seasonId}`);
    pending = request();
    await waitForLockWaiters(api.db, 1);
  });
  return pending!;
}

describe('submitting a season game', () => {
  it('records the season and the team on each side', async () => {
    const s = await setup();

    const g = await submitted(s, s.ana, seasonGame(s));

    expect(g).toMatchObject({ kind: 'season', seasonId: s.season.id, status: 'pending' });
    expect(g.openRevision!.teams).toEqual(teamsOf(s.sharks, s.jets));
    expect(subs(g)).toEqual([
      ['Ana', 'A', false],
      ['Bo', 'A', false],
      ['Cy', 'B', false],
      ['Di', 'B', false],
    ]);
  });

  it("marks a player who isn't on the side's team as its sub", async () => {
    const s = await setup();
    // Ed, who is on no team, plays for the Sharks in place of Bo.
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.ed, 5)),
        B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
      },
    });

    const g = await submitted(s, s.ed, body);

    expect(subs(g)).toEqual([
      ['Ana', 'A', false],
      ['Ed', 'A', true],
      ['Cy', 'B', false],
      ['Di', 'B', false],
    ]);
  });

  it('accepts a sub who is on a third team', async () => {
    const s = await setup();
    // Flo, an Owl, plays for the Jets in place of Di.
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
        B: side(s.jets, line(s.cy, 5), line(s.flo, 4)),
      },
    });

    const g = await submitted(s, s.ana, body);

    expect(subs(g)).toContainEqual(['Flo', 'B', true]);
  });

  it('accepts a sub on each side', async () => {
    const s = await setup();
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.ed, 5)),
        B: side(s.jets, line(s.hal, 5), line(s.di, 4)),
      },
    });

    const g = await submitted(s, s.ana, body);

    expect(g.openRevision!.players.filter((p) => p.isSub).map((p) => p.displayName)).toEqual([
      'Ed',
      'Hal',
    ]);
  });

  it('refuses two subs on one side with 422', async () => {
    const s = await setup();
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
        B: side(s.jets, line(s.ed, 5), line(s.hal, 4)),
      },
    });

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION');
    expect(error.details).toEqual([
      { code: 'TOO_MANY_SUBS', path: ['sides', 'B', 'players'], message: expect.any(String) },
    ]);
    expect(await rows('games')).toBe(0);
  });

  it("refuses a player who is on the other side's team with 422", async () => {
    const s = await setup();
    // Cy, a Jet, can't play for the Sharks against the Jets.
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.cy, 5)),
        B: side(s.jets, line(s.di, 5), line(s.ed, 4)),
      },
    });

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toContainEqual({
      code: 'OPPOSING_PLAYER',
      path: ['sides', 'A', 'players', 1, 'membershipId'],
      message: expect.any(String),
    });
    expect(await rows('games')).toBe(0);
  });

  it('refuses the same team on both sides with 422', async () => {
    const s = await setup();
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
        B: side(s.sharks, line(s.cy, 5), line(s.di, 4)),
      },
    });

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      { code: 'SAME_TEAM', path: ['sides', 'B', 'teamId'], message: expect.any(String) },
    ]);
  });

  it("refuses a team a commissioner hasn't approved with 422", async () => {
    const s = await setup();
    const rays = await proposed(s, s.ed, s.hal, s.season.id, 'Rays');
    expect((await act(s, s.hal.caller, rays.id, 'accept')).status).toBe(200);
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
        B: side(rays, line(s.ed, 5), line(s.hal, 4)),
      },
    });

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      { code: 'NOT_APPROVED_TEAM', path: ['sides', 'B', 'teamId'], message: expect.any(String) },
    ]);
  });

  it('refuses a team from another season with 422', async () => {
    const s = await setup();
    const spring = await draft(s, 'Spring 2027');
    const rays = await approved(s, s.ed, s.hal, spring.id, 'Rays');
    const body = seasonGame(s, {
      sides: {
        A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
        B: side(rays, line(s.ed, 5), line(s.hal, 4)),
      },
    });

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      { code: 'NOT_APPROVED_TEAM', path: ['sides', 'B', 'teamId'], message: expect.any(String) },
    ]);
  });

  it("refuses another league's season exactly as an unknown one", async () => {
    const x = await setup('Basement League', 'x.example.com');
    const y = await setup('Garage League', 'y.example.com');

    const theirs = await submit(x, x.ana, seasonGame(x, { seasonId: y.season.id }));
    const unknown = await submit(x, x.ana, seasonGame(x, { seasonId: randomUUID() }));

    expect(theirs.status).toBe(422);
    const error = await errorOf(theirs);
    expect(error.details).toEqual([
      { code: 'UNKNOWN_SEASON', path: ['seasonId'], message: expect.any(String) },
    ]);
    expect(await errorOf(unknown)).toEqual(error);
    expect(await rows('games')).toBe(0);
  });

  it('refuses a game played before the season started with 422', async () => {
    const s = await setup();
    const before = new Date(Date.parse(START) - SECOND).toISOString();

    const res = await submit(s, s.ana, seasonGame(s, { playedAt: before }));

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      { code: 'BEFORE_SEASON', path: ['playedAt'], message: expect.any(String) },
    ]);
  });

  it('accepts a game played the moment the season started', async () => {
    const s = await setup();

    const res = await submit(s, s.ana, seasonGame(s, { playedAt: START }));

    expect(res.status).toBe(201);
  });

  it("refuses a season that hasn't started with 409", async () => {
    const s = await setup();
    const spring = await draft(s, 'Spring 2027');
    const rays = await approved(s, s.ed, s.hal, spring.id, 'Rays');
    const owls = await approved(s, s.flo, s.gus, spring.id, 'Spring Owls');
    const body = seasonGame(s, {
      seasonId: spring.id,
      sides: {
        A: side(rays, line(s.ed, 6), line(s.hal, 5)),
        B: side(owls, line(s.flo, 5), line(s.gus, 4)),
      },
    });

    const res = await submit(s, s.ed, body);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_NOT_ACTIVE');
  });

  it('refuses a game submitted after the season ends with 409', async () => {
    const s = await setup();
    await ended(s, s.season.id);

    const res = await submit(s, s.ana, seasonGame(s));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_NOT_ACTIVE');
    expect(await rows('games')).toBe(0);
  });

  it('waits for a season being ended, then refuses the game with 409', async () => {
    const s = await setup();

    const res = await whileEnding(s.season.id, () => submit(s, s.ana, seasonGame(s)));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_NOT_ACTIVE');
    expect(await rows('games')).toBe(0);
  });

  it('returns the original game to a retry after the season ends', async () => {
    const s = await setup();
    const body = seasonGame(s);
    const g = await submitted(s, s.ana, body);
    await ended(s, s.season.id);

    const res = await submit(s, s.ana, body);

    expect(res.status).toBe(200);
    expect(GameResponse.parse(await res.json()).game.id).toBe(g.id);
    expect(await rows('games')).toBe(1);
  });

  it('refuses a retry that names a different team with 409', async () => {
    const s = await setup();
    const body = seasonGame(s);
    await submitted(s, s.ana, body);

    // The same players and numbers, filed against the Owls instead of the Jets.
    const res = await submit(s, s.ana, {
      ...body,
      sides: { ...body.sides, B: { ...body.sides.B, teamId: s.owls.id } },
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('correcting a season game', () => {
  it('keeps the teams and subs of the revision it corrects', async () => {
    const s = await setup();
    const g = await submitted(
      s,
      s.ana,
      seasonGame(s, {
        sides: {
          A: side(s.sharks, line(s.ana, 6), line(s.ed, 5)),
          B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
        },
      }),
    );

    const fixed = await corrected(
      s,
      s.ed,
      g,
      correction(
        g.openRevision!.id,
        [line(s.ana, 6), line(s.ed, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(fixed.openRevision!.number).toBe(2);
    expect(fixed.openRevision!.teams).toEqual(teamsOf(s.sharks, s.jets));
    expect(subs(fixed)).toEqual([
      ['Ana', 'A', false],
      ['Ed', 'A', true],
      ['Cy', 'B', false],
      ['Di', 'B', false],
    ]);
  });

  it('swaps the teams along with the players when a correction swaps the sides', async () => {
    const s = await setup();
    const g = await submitted(s, s.ana, seasonGame(s));

    const fixed = await corrected(
      s,
      s.ana,
      g,
      correction(
        g.openRevision!.id,
        [line(s.cy, 5), line(s.di, 4)],
        [line(s.ana, 6), line(s.bo, 5)],
        { winner: 'B' },
      ),
    );

    expect(fixed.openRevision!.teams).toEqual(teamsOf(s.jets, s.sharks));
  });

  it('refuses a correction that moves players between teams with 422', async () => {
    const s = await setup();
    const g = await submitted(s, s.ana, seasonGame(s));

    const res = await correct(
      s,
      s.ana,
      g,
      correction(
        g.openRevision!.id,
        [line(s.ana, 6), line(s.cy, 5)],
        [line(s.bo, 5), line(s.di, 4)],
      ),
    );

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      {
        code: 'TEAM_CHANGED',
        path: ['sides', 'A', 'players', 1, 'membershipId'],
        message: expect.any(String),
      },
      {
        code: 'TEAM_CHANGED',
        path: ['sides', 'B', 'players', 0, 'membershipId'],
        message: expect.any(String),
      },
    ]);
    expect(await rows('game_revisions')).toBe(1);
  });

  it("keeps who played for whom after a commissioner changes a team's roster", async () => {
    const s = await setup();
    const g = await submitted(s, s.ana, seasonGame(s));
    // Ed replaces Bo on the Sharks.
    const edited = await call('PUT', `/api/leagues/${s.leagueId}/teams/${s.sharks.id}/roster`, {
      as: s.commissioner,
      body: { membershipIds: [s.ana.membershipId, s.ed.membershipId] },
    });
    expect(edited.status).toBe(200);

    const fixed = await corrected(
      s,
      s.bo,
      g,
      correction(
        g.openRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(fixed.openRevision!.teams).toEqual(teamsOf(s.sharks, s.jets));
    expect(subs(fixed)).toContainEqual(['Bo', 'A', false]);
  });

  it('refuses a correction played before the season started with 422', async () => {
    const s = await setup();
    const g = await submitted(s, s.ana, seasonGame(s));
    const before = new Date(Date.parse(START) - SECOND).toISOString();

    const res = await correct(
      s,
      s.ana,
      g,
      correction(
        g.openRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 4)],
        { playedAt: before },
      ),
    );

    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual([
      { code: 'BEFORE_SEASON', path: ['playedAt'], message: expect.any(String) },
    ]);
  });

  it('can still be corrected and confirmed after the season ends', async () => {
    const s = await setup();
    const g = await submitted(s, s.ana, seasonGame(s));
    expect((await ended(s, s.season.id)).status).toBe('ended');

    let fixed = await corrected(
      s,
      s.bo,
      g,
      correction(
        g.openRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );
    for (const p of [s.ana, s.cy, s.di]) fixed = await confirmed(s, p, fixed);

    expect(fixed.status).toBe('confirmed');
    expect(fixed.confirmedRevision!.teams).toEqual(teamsOf(s.sharks, s.jets));
  });
});

describe('reopening a season game', () => {
  it('reopens a confirmed season game while its season is active', async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));
    clock.advance(DAY);

    const reopened = await corrected(
      s,
      s.bo,
      g,
      correction(
        g.confirmedRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(reopened.status).toBe('confirmed');
    expect(reopened.windowExpiresAt).toBe(new Date(clock.now().getTime() + 7 * DAY).toISOString());
    expect(reopened.openRevision!.teams).toEqual(teamsOf(s.sharks, s.jets));
    expect(reopened.confirmedRevision!.id).toBe(g.confirmedRevision!.id);
  });

  it("keeps a confirmed game's teams and subs through a later roster change", async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));
    const edited = await call('PUT', `/api/leagues/${s.leagueId}/teams/${s.sharks.id}/roster`, {
      as: s.commissioner,
      body: { membershipIds: [s.ana.membershipId, s.ed.membershipId] },
    });
    expect(edited.status).toBe(200);

    const reopened = await corrected(
      s,
      s.bo,
      g,
      correction(
        g.confirmedRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(reopened.confirmedRevision).toEqual(g.confirmedRevision);
    expect(subs(reopened)).toContainEqual(['Bo', 'A', false]);
  });

  it('refuses to reopen once the season has ended with 409', async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));
    // Another game still open keeps the season from finalizing.
    await submitted(s, s.cy, seasonGame(s));
    expect((await ended(s, s.season.id)).status).toBe('ended');

    const res = await correct(
      s,
      s.bo,
      g,
      correction(
        g.confirmedRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
  });

  it('refuses to reopen once the season is finalized with 409', async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));
    expect((await ended(s, s.season.id)).status).toBe('finalized');

    const res = await correct(
      s,
      s.bo,
      g,
      correction(
        g.confirmedRevision!.id,
        [line(s.ana, 6), line(s.bo, 5)],
        [line(s.cy, 5), line(s.di, 3)],
      ),
    );

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
  });

  it('waits for a season being ended, then refuses to reopen with 409', async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));

    const res = await whileEnding(s.season.id, () =>
      correct(
        s,
        s.bo,
        g,
        correction(
          g.confirmedRevision!.id,
          [line(s.ana, 6), line(s.bo, 5)],
          [line(s.cy, 5), line(s.di, 3)],
        ),
      ),
    );

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('WINDOW_CLOSED');
    expect(await rows('game_revisions')).toBe(1);
  });
});

describe('a sub in stats', () => {
  it("counts the game, points, and result in the sub's own all-time stats", async () => {
    const s = await setup();
    await counted(
      s,
      s.ana,
      seasonGame(s, {
        sides: {
          A: side(s.sharks, line(s.ana, 6), line(s.ed, 5)),
          B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
        },
      }),
    );

    const res = await call('GET', `/api/leagues/${s.leagueId}/stats/players?scope=alltime`, {
      as: s.bo.caller,
    });

    expect(res.status).toBe(200);
    const { players } = PlayerStatsResponse.parse(await res.json());
    expect(players.find((p) => p.membershipId === s.ed.membershipId)).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      points: 5,
    });
    // Bo, whom Ed replaced, didn't play.
    expect(players.some((p) => p.membershipId === s.bo.membershipId)).toBe(false);
  });
});

// The constraint Postgres names as refusing `write`.
async function refusedBy(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (error) {
    return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
  }
  throw new Error('the write was accepted');
}

// An exhibition game Ana and Bo won against Cy and Di.
async function exhibitionGame(s: Setup): Promise<Game> {
  const res = await submit(s, s.ana, {
    idempotencyKey: randomUUID(),
    kind: 'exhibition',
    playedAt: PLAYED_AT,
    sides: {
      A: { players: [line(s.ana, 6), line(s.bo, 5)] },
      B: { players: [line(s.cy, 5), line(s.di, 4)] },
    },
    winner: 'A',
  });
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

describe('the teams a revision names', () => {
  it("can't include another league's team", async () => {
    const x = await setup('Basement League', 'x.example.com');
    const y = await setup('Garage League', 'y.example.com');
    const g = await submitted(x, x.ana, seasonGame(x));

    const constraint = await refusedBy(
      api.db.execute(sql`update game_revisions set side_b_team_id = ${y.jets.id}
                         where id = ${g.openRevision!.id}`),
    );

    expect(constraint).toBe('game_revisions_side_b_team_season_fk');
  });

  it("can't be another league's season and teams", async () => {
    const x = await setup('Basement League', 'x.example.com');
    const y = await setup('Garage League', 'y.example.com');
    const g = await submitted(x, x.ana, seasonGame(x));

    const constraint = await refusedBy(
      api.db.execute(sql`update game_revisions
                         set season_id = ${y.season.id},
                             side_a_team_id = ${y.sharks.id}, side_b_team_id = ${y.jets.id}
                         where id = ${g.openRevision!.id}`),
    );

    expect(constraint).toBe('game_revisions_game_season_fk');
  });

  it("can't include a team from a season other than the game's", async () => {
    const s = await setup();
    const spring = await draft(s, 'Spring 2027');
    const rays = await approved(s, s.ed, s.hal, spring.id, 'Rays');
    const g = await submitted(s, s.ana, seasonGame(s));

    const constraint = await refusedBy(
      api.db.execute(sql`update game_revisions set side_b_team_id = ${rays.id}
                         where id = ${g.openRevision!.id}`),
    );

    expect(constraint).toBe('game_revisions_side_b_team_season_fk');
  });

  it("can't be set on an exhibition game's revision without a season", async () => {
    const s = await setup();
    const g = await exhibitionGame(s);

    const constraint = await refusedBy(
      api.db.execute(sql`update game_revisions
                         set side_a_team_id = ${s.sharks.id}, side_b_team_id = ${s.jets.id}
                         where id = ${g.openRevision!.id}`),
    );

    expect(constraint).toBe('game_revisions_teams_have_season');
  });

  it("can't be set on an exhibition game's revision with a season", async () => {
    const s = await setup();
    const g = await exhibitionGame(s);

    const constraint = await refusedBy(
      api.db.execute(sql`update game_revisions
                         set season_id = ${s.season.id},
                             side_a_team_id = ${s.sharks.id}, side_b_team_id = ${s.jets.id}
                         where id = ${g.openRevision!.id}`),
    );

    expect(constraint).toBe('game_revisions_game_season_fk');
  });
});
