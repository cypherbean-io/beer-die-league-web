import { randomUUID } from 'node:crypto';
import {
  AuditResponse,
  type CorrectGameBody,
  CreateInviteResponse,
  ErrorBody,
  type ExhibitionGameBody,
  type Game,
  GameDetailResponse,
  GameResponse,
  InboxResponse,
  JoinResponse,
  MemberResponse,
  MembersResponse,
  MeResponse,
  PartnershipStatsResponse,
  PlayerStatsResponse,
  type Season,
  type SeasonGameBody,
  SeasonResponse,
  type Team,
  TeamResponse,
  TeamsResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { sweepExpired } from '../src/domain/games.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
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

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

// Moves the clock forward to `iso`, or leaves it if it is already there.
function at(iso: string): void {
  clock.advance(Date.parse(iso) - clock.now().getTime());
}

type Player = { caller: Caller; membershipId: string };
type League = { leagueId: string; commissioner: Caller };
// Ana is the commissioner. In the active Fall season Ana and Bo are the Sharks and Cy and Di
// the Jets. Ed, Flo, Gus, and Hal are on no team.
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
  const created = await call('POST', seasonsPath(l), { as: l.commissioner, body: { name } });
  expect(created.status).toBe(201);
  const { id } = SeasonResponse.parse(await created.json()).season;
  return seasonOf(
    await call('POST', `${seasonsPath(l)}/${id}/start`, { as: l.commissioner, body: {} }),
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

function propose(l: League, proposer: Player, partner: Player, seasonId: string, name: string) {
  return call('POST', `${seasonsPath(l)}/${seasonId}/teams`, {
    as: proposer.caller,
    body: { name, partnerId: partner.membershipId },
  });
}

async function proposed(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name: string,
): Promise<Team> {
  const res = await propose(l, proposer, partner, seasonId, name);
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
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name: 'Basement League',
    email: 'ana@example.com',
    displayName: 'Ana',
  });
  const caller = await signIn(api.db, clock, 'ana@example.com');
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
  at(NOW);
  return { ...l, ana, ...players, season, sharks, jets };
}

type Line = { membershipId: string; points: number; sinks: number };

const line = (p: Player, points: number): Line => ({
  membershipId: p.membershipId,
  points,
  sinks: 0,
});

// Ana and Bo beat Cy and Di 11–9, half an hour ago.
function exhibition(s: Setup, patch: Partial<ExhibitionGameBody> = {}): ExhibitionGameBody {
  return {
    idempotencyKey: randomUUID(),
    kind: 'exhibition',
    playedAt: PLAYED_AT,
    sides: {
      A: { players: [line(s.ana, 6), line(s.bo, 5)] },
      B: { players: [line(s.cy, 5), line(s.di, 4)] },
    },
    winner: 'A',
    ...patch,
  };
}

// The same game between the Sharks and the Jets.
function seasonGame(
  s: Setup,
  teams: [Team, Team] = [s.sharks, s.jets],
  playedAt = PLAYED_AT,
): SeasonGameBody {
  return {
    idempotencyKey: randomUUID(),
    kind: 'season',
    seasonId: teams[0].seasonId,
    playedAt,
    sides: {
      A: { teamId: teams[0].id, players: [line(s.ana, 6), line(s.bo, 5)] },
      B: { teamId: teams[1].id, players: [line(s.cy, 5), line(s.di, 4)] },
    },
    winner: 'A',
  };
}

// The same four players, with Di's 4 points corrected to 3.
function correction(s: Setup, baseRevisionId: string): CorrectGameBody {
  return {
    baseRevisionId,
    playedAt: PLAYED_AT,
    sides: {
      A: { players: [line(s.ana, 6), line(s.bo, 5)] },
      B: { players: [line(s.cy, 5), line(s.di, 3)] },
    },
    winner: 'A',
  };
}

function submit(l: League, as: Player, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/games`, { as: as.caller, body });
}

async function submitted(l: League, as: Player, body: unknown): Promise<Game> {
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

// Submitted by Cy, then confirmed by Ana, Bo, and Di.
async function counted(s: Setup, body: unknown): Promise<Game> {
  let g = await submitted(s, s.cy, body);
  for (const p of [s.ana, s.bo, s.di]) g = await confirmed(s, p, g);
  expect(g.status).toBe('confirmed');
  return g;
}

function correct(l: League, as: Player, g: Game, body: unknown): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/games/${g.id}/revisions`, {
    as: as.caller,
    body,
  });
}

function remove(l: League, as: Caller, membershipId: string): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/remove`, {
    as,
    body: {},
  });
}

async function removed(l: League, membershipId: string) {
  const res = await remove(l, l.commissioner, membershipId);
  expect(res.status).toBe(200);
  return MemberResponse.parse(await res.json()).member;
}

function leave(l: League, as: Caller): Promise<Response> {
  return call('POST', `/api/leagues/${l.leagueId}/leave`, { as, body: {} });
}

// The token of a new invite link created by `as`.
async function inviteToken(l: League, as: Caller): Promise<string> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/invites`, { as, body: {} });
  expect(res.status).toBe(201);
  const { url } = CreateInviteResponse.parse(await res.json());
  return url.slice(`${APP_ORIGIN}/join/`.length);
}

function setRole(l: League, membershipId: string, role: string) {
  return call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/role`, {
    as: l.commissioner,
    body: { role },
  });
}

type GameRow = {
  status: string;
  open_revision_id: string | null;
  confirmed_revision_id: string | null;
  window_expires_at: Date | null;
};

async function gameRow(gameId: string): Promise<GameRow> {
  const [row] = await api.db.execute<GameRow>(
    sql`select status, open_revision_id, confirmed_revision_id, window_expires_at
        from games where id = ${gameId}`,
  );
  return row!;
}

// The statuses of a game's revisions, oldest first.
async function revisionStatuses(gameId: string): Promise<string[]> {
  const rows = await api.db.execute<{ status: string }>(
    sql`select status from game_revisions where game_id = ${gameId} order by number`,
  );
  return rows.map((r) => r.status);
}

async function teamStatus(teamId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from season_teams where id = ${teamId}`,
  );
  return row!.status;
}

// The members on a team's open roster rows, in the order they joined.
async function openRoster(teamId: string): Promise<string[]> {
  const rows = await api.db.execute<{ membership_id: string }>(
    sql`select membership_id from team_roster where team_id = ${teamId} and valid_to is null
        order by valid_from, id`,
  );
  return rows.map((r) => r.membership_id);
}

async function seasonStatus(seasonId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from seasons where id = ${seasonId}`,
  );
  return row!.status;
}

async function membershipStatus(membershipId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from memberships where id = ${membershipId}`,
  );
  return row!.status;
}

async function inbox(l: League, as: Player): Promise<Game[]> {
  const res = await call('GET', `/api/leagues/${l.leagueId}/inbox`, { as: as.caller });
  expect(res.status).toBe(200);
  return InboxResponse.parse(await res.json()).games;
}

async function playerStats(l: League, as: Player) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/stats/players?scope=combined`, {
    as: as.caller,
  });
  expect(res.status).toBe(200);
  return PlayerStatsResponse.parse(await res.json()).players;
}

async function partnerships(l: League, as: Player) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/stats/partnerships?scope=combined`, {
    as: as.caller,
  });
  expect(res.status).toBe(200);
  return PartnershipStatsResponse.parse(await res.json()).partnerships;
}

async function gameDetail(l: League, gameId: string) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/games/${gameId}`, {
    as: l.commissioner,
  });
  expect(res.status).toBe(200);
  return GameDetailResponse.parse(await res.json());
}

// Each listed player's name with whether they are marked as a former member.
const marks = (players: Array<{ displayName: string; former: boolean }>) =>
  players.map((p) => [p.displayName, p.former]);

async function auditLog(l: League, as: Caller = l.commissioner) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/audit`, { as });
  expect(res.status).toBe(200);
  return AuditResponse.parse(await res.json()).events;
}

async function teams(l: League, seasonId: string): Promise<Team[]> {
  const res = await call('GET', `${seasonsPath(l)}/${seasonId}/teams`, { as: l.commissioner });
  expect(res.status).toBe(200);
  return TeamsResponse.parse(await res.json()).teams;
}

describe('removing a member', () => {
  it('voids an open game they play in that never counted, and drops it from inboxes', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));
    expect((await inbox(s, s.di)).map((x) => x.id)).toEqual([g.id]);

    await removed(s, s.bo.membershipId);

    expect(await gameRow(g.id)).toEqual({
      status: 'voided',
      open_revision_id: null,
      confirmed_revision_id: null,
      window_expires_at: null,
    });
    expect(await revisionStatuses(g.id)).toEqual(['voided']);
    expect(await inbox(s, s.di)).toEqual([]);
  });

  it('keeps their confirmed games counting, under their name', async () => {
    const s = await setup();
    const g = await counted(s, exhibition(s));

    await removed(s, s.bo.membershipId);

    expect((await gameRow(g.id)).status).toBe('confirmed');
    const bo = (await playerStats(s, s.cy)).find((p) => p.membershipId === s.bo.membershipId);
    expect(bo).toMatchObject({ displayName: 'Bo', gamesPlayed: 1, wins: 1, points: 5 });
  });

  it('marks them as a former member on the games they played', async () => {
    const s = await setup();
    const g = await counted(s, exhibition(s));

    await removed(s, s.bo.membershipId);

    const { game } = await gameDetail(s, g.id);
    expect(marks(game.confirmedRevision!.players)).toEqual([
      ['Ana', false],
      ['Bo', true],
      ['Cy', false],
      ['Di', false],
    ]);
  });

  it('marks them as a former member in player stats', async () => {
    const s = await setup();
    await counted(s, exhibition(s));

    await removed(s, s.bo.membershipId);

    expect(marks(await playerStats(s, s.cy))).toEqual([
      ['Ana', false],
      ['Bo', true],
      ['Cy', false],
      ['Di', false],
    ]);
  });

  it('marks them as a former member in partnership stats', async () => {
    const s = await setup();
    await counted(s, exhibition(s));

    await removed(s, s.bo.membershipId);

    const pairs = await partnerships(s, s.cy);
    expect(pairs.map((p) => marks(p.players).sort())).toEqual([
      [
        ['Ana', false],
        ['Bo', true],
      ],
      [
        ['Cy', false],
        ['Di', false],
      ],
    ]);
  });

  it('voids a correction open on a confirmed game, which keeps counting as confirmed', async () => {
    const s = await setup();
    const g = await counted(s, exhibition(s));
    const reopened = await correct(s, s.di, g, correction(s, g.confirmedRevision!.id));
    expect(reopened.status).toBe(201);

    await removed(s, s.bo.membershipId);

    expect(await gameRow(g.id)).toEqual({
      status: 'confirmed',
      open_revision_id: null,
      confirmed_revision_id: g.confirmedRevision!.id,
      window_expires_at: null,
    });
    expect(await revisionStatuses(g.id)).toEqual(['confirmed', 'voided']);
    const di = (await playerStats(s, s.cy)).find((p) => p.membershipId === s.di.membershipId);
    expect(di?.points).toBe(4);
  });

  it('leaves open the games they don’t play in', async () => {
    const s = await setup();
    const theirs = await submitted(s, s.cy, exhibition(s));
    const others = await submitted(
      s,
      s.ed,
      exhibition(s, {
        sides: {
          A: { players: [line(s.ed, 6), line(s.flo, 5)] },
          B: { players: [line(s.gus, 5), line(s.hal, 4)] },
        },
      }),
    );

    await removed(s, s.bo.membershipId);

    expect((await gameRow(theirs.id)).status).toBe('voided');
    expect(await gameRow(others.id)).toMatchObject({
      status: 'pending',
      open_revision_id: others.openRevision!.id,
    });
  });

  it('expires, rather than voids, an open game whose window has lapsed', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));
    clock.advance(7 * DAY);

    await removed(s, s.bo.membershipId);

    expect((await gameRow(g.id)).status).toBe('expired');
    expect(await revisionStatuses(g.id)).toEqual(['expired']);
  });

  it('finalizes an ended season once voiding closes its last open game', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, seasonGame(s));
    expect((await ended(s, s.season.id)).status).toBe('ended');

    await removed(s, s.bo.membershipId);

    expect((await gameRow(g.id)).status).toBe('voided');
    expect(await seasonStatus(s.season.id)).toBe('finalized');
  });

  it('takes them off an approved team, which stays approved for a commissioner to refill', async () => {
    const s = await setup();

    await removed(s, s.bo.membershipId);

    expect(await teamStatus(s.sharks.id)).toBe('approved');
    expect(await openRoster(s.sharks.id)).toEqual([s.ana.membershipId]);
    const refilled = await call('PUT', `/api/leagues/${s.leagueId}/teams/${s.sharks.id}/roster`, {
      as: s.commissioner,
      body: { membershipIds: [s.ana.membershipId, s.ed.membershipId] },
    });
    expect(refilled.status).toBe(200);
    const sharks = (await teams(s, s.season.id)).find((t) => t.id === s.sharks.id);
    expect(sharks?.players.map((p) => p.displayName)).toEqual(['Ana', 'Ed']);
  });

  it('withdraws the teams awaiting approval they are one of the pair of, freeing the other player', async () => {
    const s = await setup();
    // Flo was asked to join Ed's Owls; Gus proposed the Hawks and Hal accepted.
    const owls = await proposed(s, s.ed, s.flo, s.season.id, 'Owls');
    const hawks = await proposed(s, s.gus, s.hal, s.season.id, 'Hawks');
    expect((await act(s, s.hal.caller, hawks.id, 'accept')).status).toBe(200);

    await removed(s, s.flo.membershipId);
    await removed(s, s.gus.membershipId);

    expect(await teamStatus(owls.id)).toBe('withdrawn');
    expect(await teamStatus(hawks.id)).toBe('withdrawn');
    expect(await openRoster(owls.id)).toEqual([]);
    expect(await openRoster(hawks.id)).toEqual([]);
    // Ed and Hal are free to team up.
    const eagles = await proposed(s, s.ed, s.hal, s.season.id, 'Eagles');
    expect((await act(s, s.hal.caller, eagles.id, 'accept')).status).toBe(200);
  });

  it('leaves a finalized season’s rosters as they finished', async () => {
    const s = await setup();
    expect((await ended(s, s.season.id)).status).toBe('finalized');

    await removed(s, s.bo.membershipId);

    expect(await openRoster(s.sharks.id)).toEqual([s.ana.membershipId, s.bo.membershipId]);
  });

  it('marks them as a former member on the finalized roster they finished on', async () => {
    const s = await setup();
    expect((await ended(s, s.season.id)).status).toBe('finalized');

    await removed(s, s.bo.membershipId);

    const sharks = (await teams(s, s.season.id)).find((t) => t.id === s.sharks.id);
    expect(marks(sharks!.players)).toEqual([
      ['Ana', false],
      ['Bo', true],
    ]);
  });

  it('marks them as a former member on a team they were withdrawn from', async () => {
    const s = await setup();
    const owls = await proposed(s, s.ed, s.flo, s.season.id, 'Owls');

    await removed(s, s.flo.membershipId);

    const listed = (await teams(s, s.season.id)).find((t) => t.id === owls.id);
    expect(marks(listed!.players)).toEqual([
      ['Ed', false],
      ['Flo', true],
    ]);
  });

  it('shuts them out of the league, and out of new games', async () => {
    const s = await setup();

    const member = await removed(s, s.bo.membershipId);

    expect(member).toMatchObject({ id: s.bo.membershipId, displayName: 'Bo', status: 'removed' });
    expect(await membershipStatus(s.bo.membershipId)).toBe('removed');
    const league = await call('GET', `/api/leagues/${s.leagueId}`, { as: s.bo.caller });
    expect(league.status).toBe(404);
    const me = await call('GET', '/api/me', { as: s.bo.caller });
    expect(MeResponse.parse(await me.json()).memberships).toEqual([]);
    const list = await call('GET', `/api/leagues/${s.leagueId}/members`, { as: s.commissioner });
    const names = MembersResponse.parse(await list.json()).members.map((m) => m.displayName);
    expect(names).not.toContain('Bo');
    const game = await submit(s, s.cy, exhibition(s));
    expect(game.status).toBe(422);
    expect(await errorCode(game)).toBe('VALIDATION');
  });

  it('records the removal in the league log, naming the member and the games it voided', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));

    await removed(s, s.bo.membershipId);
    await removed(s, s.hal.membershipId);

    const [hal, bo] = await auditLog(s, s.cy.caller);
    expect(bo).toMatchObject({
      action: 'member.removed',
      targetType: 'membership',
      targetId: s.bo.membershipId,
      actor: { membershipId: s.ana.membershipId, displayName: 'Ana' },
      // Ana played in the game the removal voided.
      actorWasParticipant: true,
      details: { voidedGameIds: [g.id] },
      player: { membershipId: s.bo.membershipId, displayName: 'Bo' },
    });
    expect(hal).toMatchObject({
      action: 'member.removed',
      actorWasParticipant: false,
      details: { voidedGameIds: [] },
      player: { membershipId: s.hal.membershipId, displayName: 'Hal' },
    });
  });

  it('treats removing a member again as a no-op', async () => {
    const s = await setup();
    await removed(s, s.bo.membershipId);

    const again = await removed(s, s.bo.membershipId);

    expect(again.status).toBe('removed');
    const removals = (await auditLog(s)).filter((e) => e.action === 'member.removed');
    expect(removals).toHaveLength(1);
  });

  it('lets a commissioner remove another commissioner', async () => {
    const s = await setup();
    expect((await setRole(s, s.bo.membershipId, 'commissioner')).status).toBe(200);

    await removed(s, s.bo.membershipId);

    const invites = await call('GET', `/api/leagues/${s.leagueId}/invites`, { as: s.bo.caller });
    expect(invites.status).toBe(404);
  });

  it('refuses to let a commissioner remove themselves', async () => {
    const s = await setup();

    const res = await remove(s, s.commissioner, s.ana.membershipId);

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('REMOVE_SELF');
    expect(await membershipStatus(s.ana.membershipId)).toBe('approved');
  });

  it('refuses to remove a member awaiting approval', async () => {
    const s = await setup();
    const created = await call('POST', `/api/leagues/${s.leagueId}/invites`, {
      as: s.commissioner,
      body: {},
    });
    const { url } = CreateInviteResponse.parse(await created.json());
    const joined = await call(
      'POST',
      `/api/invites/${url.slice(`${APP_ORIGIN}/join/`.length)}/join`,
      {
        as: await signIn(api.db, clock, 'pat@example.com'),
        body: { displayName: 'Pat' },
      },
    );
    const pat = JoinResponse.parse(await joined.json()).membership.id;

    const res = await remove(s, s.commissioner, pat);

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NOT_APPROVED');
    expect(await membershipStatus(pat)).toBe('pending');
  });

  it.each(['removal', 'leaving'] as const)(
    'revokes the invite links a commissioner created on their %s, and no one else’s',
    async (how) => {
      const s = await setup();
      expect((await setRole(s, s.bo.membershipId, 'commissioner')).status).toBe(200);
      const theirs = await inviteToken(s, s.bo.caller);
      const ours = await inviteToken(s, s.commissioner);

      const res =
        how === 'removal'
          ? await remove(s, s.commissioner, s.bo.membershipId)
          : await leave(s, s.bo.caller);

      expect(res.ok).toBe(true);
      const pat = await signIn(api.db, clock, 'pat@example.com');
      const join = (token: string) =>
        call('POST', `/api/invites/${token}/join`, { as: pat, body: { displayName: 'Pat' } });
      const refused = await join(theirs);
      expect(refused.status).toBe(404);
      expect(await errorCode(refused)).toBe('INVITE_INVALID');
      expect((await join(ours)).status).toBe(201);
    },
  );

  it('refuses an unknown member with 404', async () => {
    const s = await setup();

    const res = await remove(s, s.commissioner, randomUUID());

    expect(res.status).toBe(404);
  });
});

describe('leaving', () => {
  it('voids their open games and takes them off their team', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));

    const res = await leave(s, s.bo.caller);

    expect(res.status).toBe(204);
    expect(await membershipStatus(s.bo.membershipId)).toBe('left');
    expect((await gameRow(g.id)).status).toBe('voided');
    expect(await openRoster(s.sharks.id)).toEqual([s.ana.membershipId]);
    const league = await call('GET', `/api/leagues/${s.leagueId}`, { as: s.bo.caller });
    expect(league.status).toBe(404);
    const me = await call('GET', '/api/me', { as: s.bo.caller });
    expect(MeResponse.parse(await me.json()).memberships).toEqual([]);
  });

  it('is not recorded in the league log, which is for commissioner actions', async () => {
    const s = await setup();
    const before = await auditLog(s);

    expect((await leave(s, s.bo.caller)).status).toBe(204);

    expect(await auditLog(s)).toEqual(before);
  });

  it('refuses to let the last commissioner leave', async () => {
    const s = await setup();

    const res = await leave(s, s.commissioner);

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('LAST_COMMISSIONER');
    expect(await membershipStatus(s.ana.membershipId)).toBe('approved');
  });

  it('lets a commissioner leave while another commissioner remains', async () => {
    const s = await setup();
    expect((await setRole(s, s.bo.membershipId, 'commissioner')).status).toBe(200);

    expect((await leave(s, s.commissioner)).status).toBe(204);

    const invites = await call('GET', `/api/leagues/${s.leagueId}/invites`, { as: s.bo.caller });
    expect(invites.status).toBe(200);
  });

  it('leaves exactly one commissioner when two commissioners leave at once', async () => {
    const s = await setup();
    expect((await setRole(s, s.bo.membershipId, 'commissioner')).status).toBe(200);

    // Hold the league row, which both must lock, until both are waiting on it.
    let leaving: Promise<Response[]> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from leagues where id = ${s.leagueId} for update`);
      leaving = Promise.all([leave(s, s.commissioner), leave(s, s.bo.caller)]);
      await waitForLockWaiters(api.db, 2);
    });

    expect((await leaving!).map((r) => r.status).sort()).toEqual([204, 409]);
    const statuses = await Promise.all([s.ana, s.bo].map((p) => membershipStatus(p.membershipId)));
    expect(statuses.sort()).toEqual(['approved', 'left']);
  });
});

// Each test holds a lock that a write needs, starts the write, then starts a departure that
// must wait for it, and releases the lock once both are waiting. Both must succeed, in that
// order: the departure sees what the write committed.
describe('departures racing other writes', () => {
  it('waits for a game submission in flight, then voids the game', async () => {
    const s = await setup();

    let submitting: Promise<Response> | undefined;
    let removing: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // Di joined last, so the submission holds Bo's membership FOR SHARE and waits on Di's,
      // before it inserts the game (whose foreign key then needs the league row).
      await tx.execute(sql`select 1 from memberships where id = ${s.di.membershipId} for update`);
      submitting = submit(s, s.cy, exhibition(s));
      await waitForLockWaiters(api.db, 1);
      removing = remove(s, s.commissioner, s.bo.membershipId);
      await waitForLockWaiters(api.db, 2);
    });

    const res = await submitting!;
    expect(res.status).toBe(201);
    expect((await removing!).status).toBe(200);
    const { game } = GameResponse.parse(await res.json());
    expect((await gameRow(game.id)).status).toBe('voided');
  });

  it('waits for a correction in flight, then voids the revision it opened', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));

    let correcting: Promise<Response> | undefined;
    let removing: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from games where id = ${g.id} for update`);
      correcting = correct(s, s.di, g, correction(s, g.openRevision!.id));
      await waitForLockWaiters(api.db, 1);
      removing = remove(s, s.commissioner, s.bo.membershipId);
      await waitForLockWaiters(api.db, 2);
    });

    expect((await correcting!).status).toBe(201);
    expect((await removing!).status).toBe(200);
    expect((await gameRow(g.id)).status).toBe('voided');
    expect(await revisionStatuses(g.id)).toEqual(['superseded', 'voided']);
  });

  it.each(['force-confirm', 'override'] as const)(
    'waits for a %s in flight by the commissioner being removed, then voids the game',
    async (action) => {
      const s = await setup();
      expect((await setRole(s, s.bo.membershipId, 'commissioner')).status).toBe(200);
      // 11–10 breaks the win-by rule, so it awaits review.
      const g = await submitted(
        s,
        s.cy,
        action === 'override'
          ? exhibition(s, {
              sides: {
                A: { players: [line(s.ana, 6), line(s.bo, 5)] },
                B: { players: [line(s.cy, 5), line(s.di, 5)] },
              },
              requestOverride: true,
            })
          : exhibition(s),
      );
      const path = `/api/leagues/${s.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/${action}`;
      const body =
        action === 'override' ? { decision: 'approve' } : { membershipIds: [s.di.membershipId] };

      let acting: Promise<Response> | undefined;
      let removing: Promise<Response> | undefined;
      await api.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from games where id = ${g.id} for update`);
        acting = call('POST', path, { as: s.bo.caller, body });
        await waitForLockWaiters(api.db, 1);
        removing = remove(s, s.commissioner, s.bo.membershipId);
        await waitForLockWaiters(api.db, 2);
      });

      expect((await acting!).status).toBe(200);
      expect((await removing!).status).toBe(200);
      expect((await gameRow(g.id)).status).toBe('voided');
    },
  );

  it('waits for a team acceptance in flight, then withdraws the team', async () => {
    const s = await setup();
    const owls = await proposed(s, s.ed, s.hal, s.season.id, 'Owls');

    let accepting: Promise<Response> | undefined;
    let removing: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from seasons where id = ${s.season.id} for update`);
      accepting = act(s, s.hal.caller, owls.id, 'accept');
      await waitForLockWaiters(api.db, 1);
      removing = remove(s, s.commissioner, s.hal.membershipId);
      await waitForLockWaiters(api.db, 2);
    });

    expect((await accepting!).status).toBe(200);
    expect((await removing!).status).toBe(200);
    expect(await teamStatus(owls.id)).toBe('withdrawn');
    expect(await openRoster(owls.id)).toEqual([]);
  });

  it('waits for a team proposal in flight, then withdraws the team', async () => {
    const s = await setup();
    // Gus asked Flo to join the Hawks, so removing Flo locks the season.
    const hawks = await proposed(s, s.gus, s.flo, s.season.id, 'Hawks');

    let proposing: Promise<Response> | undefined;
    let removing: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from seasons where id = ${s.season.id} for update`);
      proposing = propose(s, s.ed, s.flo, s.season.id, 'Owls');
      await waitForLockWaiters(api.db, 1);
      removing = remove(s, s.commissioner, s.flo.membershipId);
      await waitForLockWaiters(api.db, 2);
    });

    const res = await proposing!;
    expect(res.status).toBe(201);
    expect((await removing!).status).toBe(200);
    const owls = TeamResponse.parse(await res.json()).team;
    expect(await teamStatus(owls.id)).toBe('withdrawn');
    expect(await teamStatus(hawks.id)).toBe('withdrawn');
  });

  // The sweep and a departure each lock several seasons. Here the sweep reaches the later
  // season's game first, since its window lapses sooner.
  it('locks seasons in the same order as the expiry sweep, so the two never deadlock', async () => {
    const s = await setup();
    const fall = s.season;
    const owls = await approved(s, s.ed, s.flo, fall.id, 'Owls');
    const fallGame = await submitted(s, s.cy, seasonGame(s));
    expect((await ended(s, fall.id)).status).toBe('ended');
    const winter = await started(s, 'Winter 2027');
    // Season ids are UUIDv7, so the season created first sorts first.
    expect(fall.id < winter.id).toBe(true);
    const sharks = await approved(s, s.ana, s.bo, winter.id, 'Sharks');
    const jets = await approved(s, s.cy, s.di, winter.id, 'Jets');
    const hawks = await proposed(s, s.ed, s.gus, winter.id, 'Hawks');
    const settings = await call('PATCH', `/api/leagues/${s.leagueId}/settings`, {
      as: s.commissioner,
      body: { confirmationWindowDays: 1 },
    });
    expect(settings.status).toBe(200);
    // Winter started at NOW; its game is played half an hour later and recorded an hour later.
    clock.advance(60 * 60 * SECOND);
    const winterGame = await submitted(
      s,
      s.cy,
      seasonGame(s, [sharks, jets], '2026-10-18T12:30:00.000Z'),
    );
    clock.advance(8 * DAY);

    let sweeping: Promise<{ expired: number; done: boolean }> | undefined;
    let removing: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from seasons where id = ${winter.id} for update`);
      sweeping = sweepExpired({ db: api.db, clock });
      await waitForLockWaiters(api.db, 1);
      removing = remove(s, s.commissioner, s.ed.membershipId);
      await waitForLockWaiters(api.db, 2);
    });

    expect(await sweeping!).toEqual({ expired: 2, done: true });
    expect((await removing!).status).toBe(200);
    expect((await gameRow(fallGame.id)).status).toBe('expired');
    expect((await gameRow(winterGame.id)).status).toBe('expired');
    expect(await seasonStatus(fall.id)).toBe('finalized');
    // Fall finalized before the removal reached it, so its roster stays as it finished.
    expect(await openRoster(owls.id)).toEqual([s.ed.membershipId, s.flo.membershipId]);
    expect(await teamStatus(hawks.id)).toBe('withdrawn');
  });
});
