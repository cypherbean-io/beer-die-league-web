import { randomUUID } from 'node:crypto';
import {
  type CorrectGameBody,
  CreateInviteResponse,
  type ExhibitionGameBody,
  type Game,
  GameResponse,
  JoinResponse,
  type Season,
  type SeasonGameBody,
  SeasonResponse,
  type StandingsResponse,
  StandingsResponse as StandingsResponseSchema,
  type StandingsRow,
  type Team,
  TeamResponse,
} from '@beer-die/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

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

// Moves the clock forward to `iso`.
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

async function started(l: League, name: string): Promise<Season> {
  const res = await call('POST', seasonsPath(l), { as: l.commissioner, body: { name } });
  expect(res.status).toBe(201);
  const { id } = SeasonResponse.parse(await res.json()).season;
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${id}/start`, { as: l.commissioner, body: {} }),
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
async function setup(): Promise<Setup> {
  const email = 'ana@example.com';
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name: 'Basement League',
    email,
    displayName: 'Ana',
  });
  const caller = await signIn(api.db, clock, email);
  const l = { leagueId, commissioner: caller };
  const ana = { caller, membershipId };
  const players = {
    bo: await member(l, 'bo@example.com', 'Bo'),
    cy: await member(l, 'cy@example.com', 'Cy'),
    di: await member(l, 'di@example.com', 'Di'),
    ed: await member(l, 'ed@example.com', 'Ed'),
    flo: await member(l, 'flo@example.com', 'Flo'),
    gus: await member(l, 'gus@example.com', 'Gus'),
    hal: await member(l, 'hal@example.com', 'Hal'),
  };
  const season = await started(l, 'Fall 2026');
  const sharks = await approved(l, ana, players.bo, season.id, 'Sharks');
  const jets = await approved(l, players.cy, players.di, season.id, 'Jets');
  const owls = await approved(l, players.flo, players.gus, season.id, 'Owls');
  at(NOW);
  return { ...l, ana, ...players, season, sharks, jets, owls };
}

type Line = { membershipId: string; points: number; sinks: number };

const line = (p: Player, points: number, sinks = 0): Line => ({
  membershipId: p.membershipId,
  points,
  sinks,
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

async function submitted(
  l: League,
  as: Player,
  body: SeasonGameBody | ExhibitionGameBody,
): Promise<Game> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/games`, { as: as.caller, body });
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

const playersOf = (s: Setup) => [s.ana, s.bo, s.cy, s.di, s.ed, s.flo, s.gus, s.hal];

const idsIn = (body: { sides: { A: { players: Line[] }; B: { players: Line[] } } }) =>
  [...body.sides.A.players, ...body.sides.B.players].map((p) => p.membershipId);

// Submitted by `by`, then confirmed by the other three.
async function counted(
  s: Setup,
  by: Player,
  body: SeasonGameBody | ExhibitionGameBody,
): Promise<Game> {
  const ids = idsIn(body);
  let g = await submitted(s, by, body);
  for (const p of playersOf(s)) {
    if (p !== by && ids.includes(p.membershipId)) g = await confirmed(s, p, g);
  }
  expect(g.status).toBe('confirmed');
  return g;
}

function standingsOf(l: League, seasonId: string, as: Caller): Promise<Response> {
  return call('GET', `${seasonsPath(l)}/${seasonId}/standings`, { as });
}

async function standings(l: League, seasonId: string, as: Caller): Promise<StandingsResponse> {
  const res = await standingsOf(l, seasonId, as);
  expect(res.status).toBe(200);
  return StandingsResponseSchema.parse(await res.json());
}

// Each row as [rank label, team name, W–L].
async function table(l: League, seasonId: string, as: Caller) {
  return (await standings(l, seasonId, as)).standings.map((r) => [
    r.rank === null ? '–' : r.tied ? `T-${r.rank}` : String(r.rank),
    r.team.name,
    `${r.wins}–${r.losses}`,
  ]);
}

const teamRef = (t: Team) => ({ id: t.id, name: t.name });

describe('season standings', () => {
  it("ranks the season's approved teams from its confirmed games", async () => {
    const s = await setup();
    // The Sharks beat the Jets 11–9, with a sink each side, then lost 5–11 to the Owls.
    await counted(
      s,
      s.ana,
      seasonGame(s, {
        sides: {
          A: side(s.sharks, line(s.ana, 6, 1), line(s.bo, 5)),
          B: side(s.jets, line(s.cy, 5, 1), line(s.di, 4)),
        },
      }),
    );
    await counted(
      s,
      s.flo,
      seasonGame(s, {
        sides: {
          A: side(s.owls, line(s.flo, 6), line(s.gus, 5)),
          B: side(s.sharks, line(s.ana, 3), line(s.bo, 2)),
        },
      }),
    );

    const body = await standings(s, s.season.id, s.cy.caller);

    expect(body.season).toEqual(s.season);
    expect(body.standings).toEqual<StandingsRow[]>([
      {
        team: teamRef(s.owls),
        rank: 1,
        tied: false,
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        winPct: 1,
        pointsFor: 11,
        pointsAgainst: 5,
        pointDiff: 6,
        sinks: 0,
      },
      {
        team: teamRef(s.sharks),
        rank: 2,
        tied: false,
        gamesPlayed: 2,
        wins: 1,
        losses: 1,
        winPct: 0.5,
        pointsFor: 16,
        pointsAgainst: 20,
        pointDiff: -4,
        sinks: 1,
      },
      {
        team: teamRef(s.jets),
        rank: 3,
        tied: false,
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        winPct: 0,
        pointsFor: 9,
        pointsAgainst: 11,
        pointDiff: -2,
        sinks: 1,
      },
    ]);
  });

  it('lists every approved team unranked before any game counts', async () => {
    const s = await setup();

    expect(await table(s, s.season.id, s.bo.caller)).toEqual([
      ['–', 'Jets', '0–0'],
      ['–', 'Owls', '0–0'],
      ['–', 'Sharks', '0–0'],
    ]);
  });

  it('counts a game only once all four players confirm it', async () => {
    const s = await setup();
    let g = await submitted(s, s.ana, seasonGame(s));
    g = await confirmed(s, s.bo, g);
    g = await confirmed(s, s.cy, g);

    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['–', 'Jets', '0–0'],
      ['–', 'Owls', '0–0'],
      ['–', 'Sharks', '0–0'],
    ]);

    await confirmed(s, s.di, g);

    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['1', 'Sharks', '1–0'],
      ['2', 'Jets', '0–1'],
      ['–', 'Owls', '0–0'],
    ]);
  });

  it('gives the win to the team a sub played for, with the sub’s points', async () => {
    const s = await setup();
    // Ed, who is on no team, plays for the Sharks in place of Bo.
    await counted(
      s,
      s.ana,
      seasonGame(s, {
        sides: {
          A: side(s.sharks, line(s.ana, 4), line(s.ed, 7)),
          B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
        },
      }),
    );

    const [sharks] = (await standings(s, s.season.id, s.ed.caller)).standings;

    expect(sharks).toMatchObject({ team: teamRef(s.sharks), wins: 1, pointsFor: 11 });
  });

  it('leaves out teams that are not approved, even for their own players', async () => {
    const s = await setup();
    // Ed proposes the Rays with Hal, who hasn't accepted.
    await proposed(s, s.ed, s.hal, s.season.id, 'Rays');

    for (const as of [s.ed.caller, s.hal.caller, s.commissioner]) {
      const names = (await standings(s, s.season.id, as)).standings.map((r) => r.team.name);
      expect(names).toEqual(['Jets', 'Owls', 'Sharks']);
    }
  });

  it('leaves out exhibition games between the same players', async () => {
    const s = await setup();
    await counted(s, s.ana, {
      idempotencyKey: randomUUID(),
      kind: 'exhibition',
      playedAt: PLAYED_AT,
      sides: {
        A: { players: [line(s.ana, 6), line(s.bo, 5)] },
        B: { players: [line(s.cy, 5), line(s.di, 4)] },
      },
      winner: 'A',
    });

    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['–', 'Jets', '0–0'],
      ['–', 'Owls', '0–0'],
      ['–', 'Sharks', '0–0'],
    ]);
  });

  it("counts a season's games only in its own standings, before and after it finalizes", async () => {
    const s = await setup();
    await counted(s, s.ana, seasonGame(s));
    const fall = await seasonOf(
      await call('POST', `${seasonsPath(s)}/${s.season.id}/end`, { as: s.commissioner, body: {} }),
    );
    expect(fall.status).toBe('finalized');
    const spring = await started(s, 'Spring 2027');
    await approved(s, s.ana, s.bo, spring.id, 'Sharks');

    expect(await table(s, spring.id, s.ana.caller)).toEqual([['–', 'Sharks', '0–0']]);
    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['1', 'Sharks', '1–0'],
      ['2', 'Jets', '0–1'],
      ['–', 'Owls', '0–0'],
    ]);
  });

  it('keeps counting the confirmed revision of a reopened game until the correction confirms', async () => {
    const s = await setup();
    const g = await counted(s, s.ana, seasonGame(s));
    // Cy reopens it: the Jets won 11–9.
    const correction: CorrectGameBody = {
      baseRevisionId: g.confirmedRevision!.id,
      playedAt: PLAYED_AT,
      sides: {
        A: { players: [line(s.ana, 5), line(s.bo, 4)] },
        B: { players: [line(s.cy, 6), line(s.di, 5)] },
      },
      winner: 'B',
    };
    const res = await call('POST', `/api/leagues/${s.leagueId}/games/${g.id}/revisions`, {
      as: s.cy.caller,
      body: correction,
    });
    expect(res.status).toBe(201);
    let reopened = GameResponse.parse(await res.json()).game;

    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['1', 'Sharks', '1–0'],
      ['2', 'Jets', '0–1'],
      ['–', 'Owls', '0–0'],
    ]);

    for (const p of [s.ana, s.bo, s.di]) reopened = await confirmed(s, p, reopened);

    expect(await table(s, s.season.id, s.ana.caller)).toEqual([
      ['1', 'Jets', '1–0'],
      ['2', 'Sharks', '0–1'],
      ['–', 'Owls', '0–0'],
    ]);
  });

  it("ranks by the season's standings config", async () => {
    const s = await setup();
    await counted(s, s.ana, seasonGame(s));
    // The Sharks go 2–0 and lead on win%, but play only two games; the Owls and Jets play
    // three.
    await counted(
      s,
      s.flo,
      seasonGame(s, {
        sides: {
          A: side(s.owls, line(s.flo, 6), line(s.gus, 5)),
          B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
        },
      }),
    );
    await counted(
      s,
      s.flo,
      seasonGame(s, {
        sides: {
          A: side(s.owls, line(s.flo, 6), line(s.gus, 5)),
          B: side(s.jets, line(s.cy, 5), line(s.di, 4)),
        },
      }),
    );
    await counted(
      s,
      s.ana,
      seasonGame(s, {
        sides: {
          A: side(s.sharks, line(s.ana, 6), line(s.bo, 5)),
          B: side(s.owls, line(s.flo, 5), line(s.gus, 4)),
        },
      }),
    );
    const patched = await call('PATCH', `${seasonsPath(s)}/${s.season.id}/standings-config`, {
      as: s.commissioner,
      body: { order: ['wins', 'point_diff'], minGames: 3 },
    });
    expect(patched.status).toBe(200);

    const body = await standings(s, s.season.id, s.bo.caller);

    expect(body.season.standingsConfig).toEqual({ order: ['wins', 'point_diff'], minGames: 3 });
    expect(await table(s, s.season.id, s.bo.caller)).toEqual([
      ['1', 'Owls', '2–1'],
      ['2', 'Jets', '0–3'],
      ['–', 'Sharks', '2–0'],
    ]);
  });

  it('gives 404 for a season that does not exist', async () => {
    const s = await setup();

    const res = await standingsOf(s, randomUUID(), s.ana.caller);

    expect(res.status).toBe(404);
  });
});
