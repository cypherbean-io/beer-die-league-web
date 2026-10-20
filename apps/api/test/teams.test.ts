import { randomUUID } from 'node:crypto';
import {
  AuditResponse,
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  JoinResponse,
  type Season,
  SeasonResponse,
  SeasonsResponse,
  type Team,
  TeamResponse,
  TeamsResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { TEAM_PROPOSALS_PER_HOUR, TEAM_PROPOSALS_PER_SEASON } from '../src/domain/teams.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
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

async function errorOf(res: Response) {
  return ErrorBody.parse(await res.json()).error;
}

type Player = { caller: Caller; membershipId: string };
type League = { leagueId: string; commissioner: Caller };
// Ana is the commissioner; Bo, Cy, Di, Ed, and Flo are approved members.
type Table = League & {
  ana: Player;
  bo: Player;
  cy: Player;
  di: Player;
  ed: Player;
  flo: Player;
};

// A signed-in member who has joined through the real invite flow, not yet approved.
async function pending(l: League, email: string, displayName: string): Promise<Player> {
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
  return { caller, membershipId: JoinResponse.parse(await joined.json()).membership.id };
}

async function member(l: League, email: string, displayName: string): Promise<Player> {
  const p = await pending(l, email, displayName);
  const approved = await call(
    'POST',
    `/api/leagues/${l.leagueId}/members/${p.membershipId}/approve`,
    { as: l.commissioner, body: {} },
  );
  expect(approved.status).toBe(200);
  return p;
}

async function table(name = 'Basement League', domain = 'example.com'): Promise<Table> {
  const email = `ana@${domain}`;
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName: 'Ana',
  });
  const caller = await signIn(api.db, clock, email);
  const l = { leagueId, commissioner: caller };
  return {
    ...l,
    ana: { caller, membershipId },
    bo: await member(l, `bo@${domain}`, 'Bo'),
    cy: await member(l, `cy@${domain}`, 'Cy'),
    di: await member(l, `di@${domain}`, 'Di'),
    ed: await member(l, `ed@${domain}`, 'Ed'),
    flo: await member(l, `flo@${domain}`, 'Flo'),
  };
}

const seasonsPath = (l: League) => `/api/leagues/${l.leagueId}/seasons`;

async function seasonOf(res: Response): Promise<Season> {
  expect(res.status).toBe(200);
  return SeasonResponse.parse(await res.json()).season;
}

async function draft(l: League, name = 'Fall 2026'): Promise<Season> {
  const res = await call('POST', seasonsPath(l), { as: l.commissioner, body: { name } });
  expect(res.status).toBe(201);
  return SeasonResponse.parse(await res.json()).season;
}

async function active(l: League, name = 'Fall 2026'): Promise<Season> {
  const season = await draft(l, name);
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${season.id}/start`, { as: l.commissioner, body: {} }),
  );
}

async function ended(l: League, seasonId: string): Promise<Season> {
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${seasonId}/end`, { as: l.commissioner, body: {} }),
  );
}

async function seasonNow(l: League, seasonId: string): Promise<Season> {
  const res = await call('GET', seasonsPath(l), { as: l.commissioner });
  expect(res.status).toBe(200);
  const season = SeasonsResponse.parse(await res.json()).seasons.find((s) => s.id === seasonId);
  if (!season) throw new Error('season is missing');
  return season;
}

const line = (p: Player, points: number) => ({ membershipId: p.membershipId, points, sinks: 0 });

// These tests need only an open game that keeps an ended season from finalizing, with every
// player still free to form teams, so an exhibition game is filed under the season directly
// rather than played between two of its teams; its revision names no teams, and nothing here
// corrects or reads it. Ana and Bo beat Cy and Di 11–9; it stays open, awaiting Bo, Cy, and Di.
async function openSeasonGame(t: Table, seasonId: string): Promise<Game> {
  const res = await call('POST', `/api/leagues/${t.leagueId}/games`, {
    as: t.ana.caller,
    body: {
      idempotencyKey: randomUUID(),
      kind: 'exhibition',
      playedAt: '2026-10-18T11:30:00.000Z',
      sides: {
        A: { players: [line(t.ana, 6), line(t.bo, 5)] },
        B: { players: [line(t.cy, 5), line(t.di, 4)] },
      },
      winner: 'A',
    },
  });
  expect(res.status).toBe(201);
  const { game } = GameResponse.parse(await res.json());
  await api.db.execute(sql`update games set kind = 'season', season_id = ${seasonId}
                           where id = ${game.id}`);
  return game;
}

// An active season that has ended with a game still open, so it hasn't finalized.
async function endedWithOpenGame(t: Table): Promise<Season> {
  const season = await active(t);
  await openSeasonGame(t, season.id);
  const finished = await ended(t, season.id);
  expect(finished.status).toBe('ended');
  return finished;
}

function propose(l: League, as: Player, seasonId: string, body: unknown): Promise<Response> {
  return call('POST', `${seasonsPath(l)}/${seasonId}/teams`, { as: as.caller, body });
}

async function proposed(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name = 'Sharks',
): Promise<Team> {
  const res = await propose(l, proposer, seasonId, { name, partnerId: partner.membershipId });
  expect(res.status).toBe(201);
  return TeamResponse.parse(await res.json()).team;
}

type Action = 'accept' | 'approve' | 'reject' | 'withdraw';

function act(l: League, as: Caller, team: Team, action: Action): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/teams/${team.id}/${action}`, { as, body: {} });
}

async function teamOf(res: Response): Promise<Team> {
  expect(res.status).toBe(200);
  return TeamResponse.parse(await res.json()).team;
}

async function accepted(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name = 'Sharks',
): Promise<Team> {
  const team = await proposed(l, proposer, partner, seasonId, name);
  return teamOf(await act(l, partner.caller, team, 'accept'));
}

async function approved(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name = 'Sharks',
): Promise<Team> {
  const team = await accepted(l, proposer, partner, seasonId, name);
  return teamOf(await act(l, l.commissioner, team, 'approve'));
}

function setRoster(l: League, as: Caller, team: Team, membershipIds: string[]): Promise<Response> {
  return call('PUT', `/api/leagues/${l.leagueId}/teams/${team.id}/roster`, {
    as,
    body: { membershipIds },
  });
}

async function listTeams(l: League, seasonId: string, as: Caller = l.commissioner) {
  const res = await call('GET', `${seasonsPath(l)}/${seasonId}/teams`, { as });
  expect(res.status).toBe(200);
  return TeamsResponse.parse(await res.json()).teams;
}

async function auditLog(l: League, as: Caller = l.commissioner) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/audit`, { as });
  expect(res.status).toBe(200);
  return AuditResponse.parse(await res.json()).events;
}

const named = (p: Player, displayName: string) => ({ membershipId: p.membershipId, displayName });
const rosterOf = (team: Team) => team.players.map((p) => p.membershipId);

describe('proposing a team', () => {
  it('proposes a team with a partner, who is asked to accept', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await propose(t, t.bo, season.id, {
      name: '  Table   Kings ',
      partnerId: t.cy.membershipId,
    });

    expect(res.status).toBe(201);
    const { team } = TeamResponse.parse(await res.json());
    expect(team).toEqual({
      id: team.id,
      seasonId: season.id,
      name: 'Table Kings',
      status: 'proposed',
      proposedBy: t.bo.membershipId,
      players: [named(t.bo, 'Bo'), named(t.cy, 'Cy')],
      createdAt: NOW,
    });
  });

  it('leaves the partner free to join another team until they accept', async () => {
    const t = await table();
    const season = await draft(t);
    await proposed(t, t.bo, t.cy, season.id, 'Sharks');

    const res = await propose(t, t.cy, season.id, { name: 'Aces', partnerId: t.di.membershipId });

    expect(res.status).toBe(201);
  });

  it('lets a member propose in an active season', async () => {
    const t = await table();
    const season = await active(t);

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(201);
  });

  it('refuses a partner who is the proposer with 422 VALIDATION', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.bo.membershipId });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await listTeams(t, season.id)).toEqual([]);
  });

  it("refuses a partner who isn't approved yet with 422 VALIDATION", async () => {
    const t = await table();
    const season = await draft(t);
    const gus = await pending(t, 'gus@example.com', 'Gus');

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: gus.membershipId });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it('refuses a partner from another league with 422 VALIDATION', async () => {
    const x = await table('Basement League', 'x.example.com');
    const y = await table('Garage League', 'y.example.com');
    const season = await draft(x);

    const res = await propose(x, x.bo, season.id, { name: 'Sharks', partnerId: y.cy.membershipId });

    expect(res.status).toBe(422);
    expect(await listTeams(x, season.id)).toEqual([]);
  });

  it('refuses a proposer already on a team this season with 409', async () => {
    const t = await table();
    const season = await draft(t);
    await proposed(t, t.bo, t.cy, season.id, 'Sharks');

    const res = await propose(t, t.bo, season.id, { name: 'Aces', partnerId: t.di.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('ALREADY_ON_TEAM');
    expect(await listTeams(t, season.id)).toHaveLength(1);
  });

  it('refuses a partner who has already joined a team this season with 409', async () => {
    const t = await table();
    const season = await draft(t);
    await accepted(t, t.bo, t.cy, season.id, 'Sharks');

    const res = await propose(t, t.di, season.id, { name: 'Aces', partnerId: t.cy.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('ALREADY_ON_TEAM');
  });

  it('refuses a player whose team is approved with 409', async () => {
    const t = await table();
    const season = await draft(t);
    await approved(t, t.bo, t.cy, season.id);

    const res = await propose(t, t.di, season.id, { name: 'Aces', partnerId: t.bo.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('ALREADY_ON_TEAM');
  });

  it('lets a player be on a team in each season', async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');
    await approved(t, t.bo, t.cy, fall.id);

    const res = await propose(t, t.bo, spring.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(201);
  });

  it('keeps exactly one of two proposals by one member at once', async () => {
    const t = await table();
    const season = await draft(t);

    const responses = await Promise.all([
      propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId }),
      propose(t, t.bo, season.id, { name: 'Aces', partnerId: t.di.membershipId }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await listTeams(t, season.id)).toHaveLength(1);
  });

  it('refuses a name a team in the season already has, ignoring case, with 409', async () => {
    const t = await table();
    const season = await draft(t);
    await proposed(t, t.bo, t.cy, season.id, 'Sharks');

    const res = await propose(t, t.di, season.id, { name: 'SHARKS', partnerId: t.ed.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NAME_TAKEN');
  });

  it('lets a name be used again once its team has withdrawn', async () => {
    const t = await table();
    const season = await draft(t);
    const sharks = await proposed(t, t.bo, t.cy, season.id, 'Sharks');
    await teamOf(await act(t, t.bo.caller, sharks, 'withdraw'));

    const res = await propose(t, t.di, season.id, { name: 'Sharks', partnerId: t.ed.membershipId });

    expect(res.status).toBe(201);
  });

  it('refuses an invalid name with 422 VALIDATION', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await propose(t, t.bo, season.id, {
      name: 'Sharks\nApproved',
      partnerId: t.cy.membershipId,
    });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it('refuses a proposal once the season has ended with 409', async () => {
    const t = await table();
    const season = await endedWithOpenGame(t);

    const res = await propose(t, t.ed, season.id, {
      name: 'Sharks',
      partnerId: t.flo.membershipId,
    });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_ENDED');
  });

  it('refuses a proposal in a finalized season with 409', async () => {
    const t = await table();
    const season = await active(t);
    expect((await ended(t, season.id)).status).toBe('finalized');

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_ENDED');
  });

  it(`refuses a member's proposal past ${TEAM_PROPOSALS_PER_HOUR} in an hour with 429`, async () => {
    const t = await table();
    const season = await draft(t);
    for (let i = 0; i < TEAM_PROPOSALS_PER_HOUR; i++) {
      const refused = await propose(t, t.bo, season.id, {
        name: 'Sharks',
        partnerId: t.bo.membershipId,
      });
      expect(refused.status).toBe(422);
    }

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('RATE_LIMITED');
    expect(await listTeams(t, season.id)).toEqual([]);
  });

  it('lets a member propose again once the hour has passed', async () => {
    const t = await table();
    const season = await draft(t);
    for (let i = 0; i < TEAM_PROPOSALS_PER_HOUR; i++) {
      await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.bo.membershipId });
    }
    clock.advance(HOUR);

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(201);
  });

  it(`refuses a member's proposal past ${TEAM_PROPOSALS_PER_SEASON} in a season with 409`, async () => {
    const t = await table();
    const season = await draft(t);
    for (let i = 0; i < TEAM_PROPOSALS_PER_SEASON; i++) {
      const team = await proposed(t, t.bo, t.cy, season.id, `Team ${i}`);
      await teamOf(await act(t, t.cy.caller, team, 'withdraw'));
    }
    clock.advance(HOUR);

    const res = await propose(t, t.bo, season.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('PROPOSAL_LIMIT');
  });

  it("counts a member's proposals in each season separately", async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');
    for (let i = 0; i < TEAM_PROPOSALS_PER_SEASON; i++) {
      const team = await proposed(t, t.bo, t.cy, fall.id, `Team ${i}`);
      await teamOf(await act(t, t.cy.caller, team, 'withdraw'));
    }
    clock.advance(HOUR);

    const res = await propose(t, t.bo, spring.id, { name: 'Sharks', partnerId: t.cy.membershipId });

    expect(res.status).toBe(201);
  });

  it('gives 404 for an unknown season', async () => {
    const t = await table();

    const res = await propose(t, t.bo, randomUUID(), {
      name: 'Sharks',
      partnerId: t.cy.membershipId,
    });

    expect(res.status).toBe(404);
  });
});

describe("listing a season's teams", () => {
  it('lists every team both players have agreed to, to every member, by name', async () => {
    const t = await table();
    const season = await draft(t);
    await accepted(t, t.bo, t.cy, season.id, 'Sharks');
    await approved(t, t.di, t.ed, season.id, 'aces');

    const teams = await listTeams(t, season.id, t.flo.caller);

    expect(teams.map((team) => [team.name, team.status])).toEqual([
      ['aces', 'approved'],
      ['Sharks', 'accepted'],
    ]);
  });

  it('shows a proposal only to its two players and the commissioners', async () => {
    const t = await table();
    const season = await draft(t);
    const sharks = await proposed(t, t.bo, t.cy, season.id);

    const seenBy = async (as: Caller) => (await listTeams(t, season.id, as)).map((x) => x.id);

    expect(await seenBy(t.bo.caller)).toEqual([sharks.id]);
    expect(await seenBy(t.cy.caller)).toEqual([sharks.id]);
    expect(await seenBy(t.commissioner)).toEqual([sharks.id]);
    expect(await seenBy(t.di.caller)).toEqual([]);
  });

  it('shows a withdrawn team, with the pair that proposed it, only to that pair and the commissioners', async () => {
    const t = await table();
    const season = await draft(t);
    const sharks = await accepted(t, t.bo, t.cy, season.id);
    await teamOf(await act(t, t.bo.caller, sharks, 'withdraw'));

    const [team] = await listTeams(t, season.id, t.cy.caller);

    expect(team).toMatchObject({
      status: 'withdrawn',
      players: [named(t.bo, 'Bo'), named(t.cy, 'Cy')],
    });
    expect(await listTeams(t, season.id, t.commissioner)).toHaveLength(1);
    expect(await listTeams(t, season.id, t.di.caller)).toEqual([]);
  });

  it("does not list another season's teams", async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');
    await proposed(t, t.bo, t.cy, fall.id);

    expect(await listTeams(t, spring.id)).toEqual([]);
  });

  it('gives 404 for an unknown season', async () => {
    const t = await table();

    const res = await call('GET', `${seasonsPath(t)}/${randomUUID()}/teams`, { as: t.bo.caller });

    expect(res.status).toBe(404);
  });
});

describe('accepting a proposal', () => {
  it('lets the partner accept, which leaves the team awaiting a commissioner', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const accepted = await teamOf(await act(t, t.cy.caller, team, 'accept'));

    expect(accepted).toEqual({ ...team, status: 'accepted' });
  });

  it('returns an accepted team unchanged when the partner accepts again', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const again = await teamOf(await act(t, t.cy.caller, team, 'accept'));

    expect(again).toEqual(team);
  });

  it('refuses the proposer with 403', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const res = await act(t, t.bo.caller, team, 'accept');

    expect(res.status).toBe(403);
    expect((await listTeams(t, season.id))[0]!.status).toBe('proposed');
  });

  it('refuses a commissioner who is not on the team with 403', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const res = await act(t, t.commissioner, team, 'accept');

    expect(res.status).toBe(403);
  });

  it('refuses a partner who has joined another team since with 409', async () => {
    const t = await table();
    const season = await draft(t);
    const sharks = await proposed(t, t.bo, t.cy, season.id, 'Sharks');
    await accepted(t, t.di, t.cy, season.id, 'Aces');

    const res = await act(t, t.cy.caller, sharks, 'accept');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('ALREADY_ON_TEAM');
    const mine = await listTeams(t, season.id, t.bo.caller);
    expect(mine.find((x) => x.id === sharks.id)!.status).toBe('proposed');
  });

  it('lets the partner accept only one of two proposals at once', async () => {
    const t = await table();
    const season = await draft(t);
    const sharks = await proposed(t, t.bo, t.cy, season.id, 'Sharks');
    const aces = await proposed(t, t.di, t.cy, season.id, 'Aces');

    const responses = await Promise.all([
      act(t, t.cy.caller, sharks, 'accept'),
      act(t, t.cy.caller, aces, 'accept'),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const statuses = (await listTeams(t, season.id)).map((x) => x.status).sort();
    expect(statuses).toEqual(['accepted', 'proposed']);
  });

  it('refuses a withdrawn proposal with 409', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);
    await teamOf(await act(t, t.bo.caller, team, 'withdraw'));

    const res = await act(t, t.cy.caller, team, 'accept');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NOT_PROPOSED');
  });

  it('refuses once the season has ended with 409', async () => {
    const t = await table();
    const season = await active(t);
    const team = await proposed(t, t.ed, t.flo, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await act(t, t.flo.caller, team, 'accept');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_ENDED');
  });

  it('gives 404 for an unknown team', async () => {
    const t = await table();

    const res = await call('POST', `/api/leagues/${t.leagueId}/teams/${randomUUID()}/accept`, {
      as: t.cy.caller,
      body: {},
    });

    expect(res.status).toBe(404);
  });
});

describe('approving a team', () => {
  it('approves an accepted team and audits it, naming the team and its season', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const approvedTeam = await teamOf(await act(t, t.commissioner, team, 'approve'));

    expect(approvedTeam).toEqual({ ...team, status: 'approved' });
    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'team.approved',
      targetType: 'team',
      targetId: team.id,
      actorWasParticipant: false,
      team: { id: team.id, name: 'Sharks' },
      season: { id: season.id, name: 'Fall 2026' },
    });
  });

  it('flags a commissioner approving their own team', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.ana, t.bo, season.id);

    await teamOf(await act(t, t.commissioner, team, 'approve'));

    const [event] = await auditLog(t);
    expect(event).toMatchObject({ action: 'team.approved', actorWasParticipant: true });
  });

  it("refuses a team whose partner hasn't accepted with 409", async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const res = await act(t, t.commissioner, team, 'approve');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NOT_ACCEPTED');
    expect(await auditLog(t)).toEqual([]);
  });

  it('returns an approved team unchanged when approved again, auditing it once', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const again = await teamOf(await act(t, t.commissioner, team, 'approve'));

    expect(again).toEqual(team);
    expect((await auditLog(t)).map((e) => e.action)).toEqual(['team.approved']);
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const res = await act(t, t.bo.caller, team, 'approve');

    expect(res.status).toBe(403);
    expect((await listTeams(t, season.id))[0]!.status).toBe('accepted');
  });

  it('refuses once the season has ended with 409', async () => {
    const t = await table();
    const season = await active(t);
    const team = await accepted(t, t.ed, t.flo, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await act(t, t.commissioner, team, 'approve');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_ENDED');
  });
});

describe('rejecting a team', () => {
  it('rejects a proposed team, audits it, and frees its players', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const rejected = await teamOf(await act(t, t.commissioner, team, 'reject'));

    expect(rejected.status).toBe('rejected');
    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'team.rejected',
      targetType: 'team',
      targetId: team.id,
      team: { id: team.id, name: 'Sharks' },
      season: { id: season.id, name: 'Fall 2026' },
    });
    const res = await propose(t, t.cy, season.id, { name: 'Aces', partnerId: t.bo.membershipId });
    expect(res.status).toBe(201);
  });

  it('names a rejected proposal in the log only to its pair and the commissioners', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id, 'Sharks');
    await teamOf(await act(t, t.commissioner, team, 'reject'));

    const [toOthers] = await auditLog(t, t.di.caller);
    const [toPartner] = await auditLog(t, t.cy.caller);

    expect(toOthers).toMatchObject({
      action: 'team.rejected',
      details: { status: 'proposed' },
      team: null,
      season: { id: season.id, name: 'Fall 2026' },
    });
    expect(toPartner).toMatchObject({ team: { id: team.id, name: 'Sharks' } });
  });

  it('names a rejected team both players had agreed to in the log to every member', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id, 'Sharks');
    await teamOf(await act(t, t.commissioner, team, 'reject'));

    const [event] = await auditLog(t, t.di.caller);

    expect(event).toMatchObject({
      action: 'team.rejected',
      details: { status: 'accepted' },
      team: { id: team.id, name: 'Sharks' },
    });
  });

  it('rejects an accepted team', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const rejected = await teamOf(await act(t, t.commissioner, team, 'reject'));

    expect(rejected.status).toBe('rejected');
  });

  it('refuses to reject an approved team with 409', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const res = await act(t, t.commissioner, team, 'reject');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NOT_PENDING');
  });

  it('frees the players of a team still pending when the season ended, for a roster change', async () => {
    const t = await table();
    const season = await active(t);
    const sharks = await approved(t, t.bo, t.cy, season.id, 'Sharks');
    const aces = await accepted(t, t.ed, t.flo, season.id, 'Aces');
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const rejected = await teamOf(await act(t, t.commissioner, aces, 'reject'));

    expect(rejected.status).toBe('rejected');
    const res = await setRoster(t, t.commissioner, sharks, [t.bo.membershipId, t.ed.membershipId]);
    expect(res.status).toBe(200);
  });

  it('refuses once the season is finalized with 409', async () => {
    const t = await table();
    const season = await active(t);
    const team = await proposed(t, t.bo, t.cy, season.id);
    await ended(t, season.id);

    const res = await act(t, t.commissioner, team, 'reject');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
  });

  it('refuses a member who is not a commissioner, even the partner, with 403', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const res = await act(t, t.cy.caller, team, 'reject');

    expect(res.status).toBe(403);
    expect((await listTeams(t, season.id))[0]!.status).toBe('proposed');
  });
});

describe('withdrawing a team', () => {
  it('lets the proposer withdraw a proposal, which frees both players', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const withdrawn = await teamOf(await act(t, t.bo.caller, team, 'withdraw'));

    expect(withdrawn.status).toBe('withdrawn');
    expect(
      (await propose(t, t.bo, season.id, { name: 'Aces', partnerId: t.di.membershipId })).status,
    ).toBe(201);
    expect(
      (await propose(t, t.cy, season.id, { name: 'Jets', partnerId: t.ed.membershipId })).status,
    ).toBe(201);
  });

  it('lets the partner decline a proposal by withdrawing it', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const withdrawn = await teamOf(await act(t, t.cy.caller, team, 'withdraw'));

    expect(withdrawn.status).toBe('withdrawn');
  });

  it('lets either player withdraw an accepted team', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const withdrawn = await teamOf(await act(t, t.cy.caller, team, 'withdraw'));

    expect(withdrawn.status).toBe('withdrawn');
  });

  it('returns a withdrawn team unchanged when withdrawn again', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);
    const withdrawn = await teamOf(await act(t, t.bo.caller, team, 'withdraw'));

    const again = await teamOf(await act(t, t.cy.caller, team, 'withdraw'));

    expect(again).toEqual(withdrawn);
  });

  it('refuses to withdraw an approved team with 409', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const res = await act(t, t.bo.caller, team, 'withdraw');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NOT_PENDING');
  });

  it('refuses a member who is not on the team, even a commissioner, with 403', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await proposed(t, t.bo, t.cy, season.id);

    const res = await act(t, t.commissioner, team, 'withdraw');

    expect(res.status).toBe(403);
    expect((await listTeams(t, season.id))[0]!.status).toBe('proposed');
  });

  it('lets a player withdraw a pending team after the season has ended', async () => {
    const t = await table();
    const season = await active(t);
    const team = await accepted(t, t.ed, t.flo, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const withdrawn = await teamOf(await act(t, t.flo.caller, team, 'withdraw'));

    expect(withdrawn.status).toBe('withdrawn');
  });

  it('refuses once the season is finalized with 409', async () => {
    const t = await table();
    const season = await active(t);
    const team = await proposed(t, t.bo, t.cy, season.id);
    await ended(t, season.id);

    const res = await act(t, t.bo.caller, team, 'withdraw');

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
  });

  it('audits nothing a player does', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    await teamOf(await act(t, t.bo.caller, team, 'withdraw'));

    expect(await auditLog(t)).toEqual([]);
  });
});

describe("editing an approved team's roster", () => {
  it("closes the outgoing player's roster row and opens the incoming player's", async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);
    clock.advance(DAY);

    const edited = await teamOf(
      await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]),
    );

    expect(edited).toEqual({ ...team, players: [named(t.bo, 'Bo'), named(t.di, 'Di')] });
    const rows = await api.db.execute<{
      membership_id: string;
      valid_from: Date;
      valid_to: Date | null;
    }>(sql`select membership_id, valid_from, valid_to from team_roster where team_id = ${team.id}`);
    const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
    const byPlayer = Object.fromEntries(
      rows.map((r) => [r.membership_id, { from: iso(r.valid_from), to: iso(r.valid_to) }]),
    );
    const later = clock.now().toISOString();
    expect(byPlayer).toEqual({
      [t.bo.membershipId]: { from: NOW, to: null },
      [t.cy.membershipId]: { from: NOW, to: later },
      [t.di.membershipId]: { from: later, to: null },
    });
  });

  it('audits the change, naming the players before and after', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    await teamOf(await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]));

    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'team.roster_updated',
      targetType: 'team',
      targetId: team.id,
      actorWasParticipant: false,
      team: { id: team.id, name: 'Sharks' },
      season: { id: season.id, name: 'Fall 2026' },
      details: {
        before: [t.bo.membershipId, t.cy.membershipId],
        after: [t.bo.membershipId, t.di.membershipId],
      },
      roster: {
        before: [named(t.bo, 'Bo'), named(t.cy, 'Cy')],
        after: [named(t.bo, 'Bo'), named(t.di, 'Di')],
      },
    });
  });

  it('frees the outgoing player to join another team', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);
    await teamOf(await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]));

    const res = await propose(t, t.cy, season.id, { name: 'Aces', partnerId: t.ed.membershipId });

    expect(res.status).toBe(201);
  });

  it('writes and audits nothing when the roster is unchanged, in either order', async () => {
    const t = await table();
    const season = await draft(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const same = await teamOf(
      await setRoster(t, t.commissioner, team, [t.cy.membershipId, t.bo.membershipId]),
    );

    expect(same).toEqual(team);
    expect((await auditLog(t)).map((e) => e.action)).toEqual(['team.approved']);
  });

  it('flags a commissioner who puts themselves on the roster', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    await teamOf(await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.ana.membershipId]));

    const [event] = await auditLog(t);
    expect(event).toMatchObject({ action: 'team.roster_updated', actorWasParticipant: true });
  });

  it('refuses a player already on another team this season with 409', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id, 'Sharks');
    await proposed(t, t.di, t.ed, season.id, 'Aces');

    const res = await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('ALREADY_ON_TEAM');
    const sharks = (await listTeams(t, season.id)).find((x) => x.id === team.id)!;
    expect(rosterOf(sharks)).toEqual([t.bo.membershipId, t.cy.membershipId]);
  });

  it("refuses a player who isn't an approved member with 422 VALIDATION", async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);
    const gus = await pending(t, 'gus@example.com', 'Gus');

    const res = await setRoster(t, t.commissioner, team, [t.bo.membershipId, gus.membershipId]);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it("refuses a team that isn't approved with 409", async () => {
    const t = await table();
    const season = await active(t);
    const team = await accepted(t, t.bo, t.cy, season.id);

    const res = await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('TEAM_NOT_APPROVED');
  });

  it('refuses a roster that is not two different players with 422 VALIDATION', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const res = await setRoster(t, t.commissioner, team, [
      t.bo.membershipId,
      t.cy.membershipId,
      t.di.membershipId,
    ]);

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it('can still change once the season has ended, while a game is open', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.ed, t.flo, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await setRoster(t, t.commissioner, team, [t.ed.membershipId, t.ana.membershipId]);

    expect(res.status).toBe(200);
  });

  it('is locked once the season is finalized', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);
    await ended(t, season.id);

    const res = await setRoster(t, t.commissioner, team, [t.bo.membershipId, t.di.membershipId]);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
    expect(rosterOf((await listTeams(t, season.id))[0]!)).toEqual([
      t.bo.membershipId,
      t.cy.membershipId,
    ]);
  });

  it("is locked once the last open game's window lapses, before anything settles it", async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.ed, t.flo, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);
    clock.advance(7 * DAY);

    const res = await setRoster(t, t.commissioner, team, [t.ed.membershipId, t.ana.membershipId]);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
    expect(await seasonNow(t, season.id)).toMatchObject({
      status: 'finalized',
      finalizedAt: clock.now().toISOString(),
    });
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();
    const season = await active(t);
    const team = await approved(t, t.bo, t.cy, season.id);

    const res = await setRoster(t, t.bo.caller, team, [t.bo.membershipId, t.di.membershipId]);

    expect(res.status).toBe(403);
  });
});

describe('the roster table', () => {
  it('holds a player on at most one open roster row per season', async () => {
    const t = await table();
    const season = await draft(t);
    await proposed(t, t.bo, t.cy, season.id, 'Sharks');
    const aces = await proposed(t, t.di, t.ed, season.id, 'Aces');

    await expect(
      api.db.execute(sql`insert into team_roster (team_id, season_id, membership_id, valid_from)
                         values (${aces.id}, ${season.id}, ${t.bo.membershipId}, now())`),
    ).rejects.toThrow();
  });

  it("keeps each roster row in its team's season", async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');
    const sharks = await proposed(t, t.bo, t.cy, fall.id);

    await expect(
      api.db.execute(sql`insert into team_roster (team_id, season_id, membership_id, valid_from)
                         values (${sharks.id}, ${spring.id}, ${t.di.membershipId}, now())`),
    ).rejects.toThrow();
  });
});
