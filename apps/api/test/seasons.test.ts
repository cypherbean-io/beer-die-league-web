import { randomUUID } from 'node:crypto';
import {
  AuditResponse,
  CreateInviteResponse,
  DEFAULT_STANDINGS_CONFIG,
  ErrorBody,
  type Game,
  GameResponse,
  JoinResponse,
  type ExhibitionGameBody,
  type Season,
  SeasonResponse,
  SeasonsResponse,
  type Team,
  TeamResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { sweepExpired } from '../src/domain/games.ts';
import { SEASON_CREATES_PER_HOUR } from '../src/domain/seasons.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
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
  teamsBySeason.clear();
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
  };
}

const seasonsPath = (l: League) => `/api/leagues/${l.leagueId}/seasons`;

function createSeason(l: League, as: Caller, body: unknown): Promise<Response> {
  return call('POST', seasonsPath(l), { as, body });
}

async function draft(l: League, name = 'Fall 2026'): Promise<Season> {
  const res = await createSeason(l, l.commissioner, { name });
  expect(res.status).toBe(201);
  return SeasonResponse.parse(await res.json()).season;
}

function start(l: League, as: Caller, seasonId: string): Promise<Response> {
  return call('POST', `${seasonsPath(l)}/${seasonId}/start`, { as, body: {} });
}

function end(l: League, as: Caller, seasonId: string): Promise<Response> {
  return call('POST', `${seasonsPath(l)}/${seasonId}/end`, { as, body: {} });
}

function patchConfig(l: League, as: Caller, seasonId: string, body: unknown) {
  return call('PATCH', `${seasonsPath(l)}/${seasonId}/standings-config`, { as, body });
}

async function seasonOf(res: Response): Promise<Season> {
  expect(res.status).toBe(200);
  return SeasonResponse.parse(await res.json()).season;
}

async function active(l: League, name = 'Fall 2026'): Promise<Season> {
  const season = await draft(l, name);
  return seasonOf(await start(l, l.commissioner, season.id));
}

async function ended(l: League, seasonId: string): Promise<Season> {
  return seasonOf(await end(l, l.commissioner, seasonId));
}

async function listSeasons(l: League, as: Caller = l.commissioner): Promise<Season[]> {
  const res = await call('GET', seasonsPath(l), { as });
  expect(res.status).toBe(200);
  return SeasonsResponse.parse(await res.json()).seasons;
}

async function seasonNow(l: League, seasonId: string): Promise<Season> {
  const season = (await listSeasons(l)).find((s) => s.id === seasonId);
  if (!season) throw new Error('season is missing');
  return season;
}

async function auditLog(l: League) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/audit`, { as: l.commissioner });
  expect(res.status).toBe(200);
  return AuditResponse.parse(await res.json()).events;
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

async function submitted(t: Table, body: unknown = game(t)): Promise<Game> {
  const res = await call('POST', `/api/leagues/${t.leagueId}/games`, {
    as: t.ana.caller,
    body,
  });
  expect(res.status).toBe(201);
  return GameResponse.parse(await res.json()).game;
}

async function approvedTeam(t: Table, a: Player, b: Player, seasonId: string, name: string) {
  const proposed = await call('POST', `${seasonsPath(t)}/${seasonId}/teams`, {
    as: a.caller,
    body: { name, partnerId: b.membershipId },
  });
  expect(proposed.status).toBe(201);
  const { team } = TeamResponse.parse(await proposed.json());
  const teamPath = `/api/leagues/${t.leagueId}/teams/${team.id}`;
  expect((await call('POST', `${teamPath}/accept`, { as: b.caller, body: {} })).status).toBe(200);
  expect((await call('POST', `${teamPath}/approve`, { as: t.commissioner, body: {} })).status).toBe(
    200,
  );
  return team;
}

// Each season's teams, formed the first time a test files a game in it: Ana and Bo are the
// Sharks, Cy and Di the Jets.
const teamsBySeason = new Map<string, { sharks: Team; jets: Team }>();

async function teamsOf(t: Table, seasonId: string): Promise<{ sharks: Team; jets: Team }> {
  let teams = teamsBySeason.get(seasonId);
  if (!teams) {
    teams = {
      sharks: await approvedTeam(t, t.ana, t.bo, seasonId, 'Sharks'),
      jets: await approvedTeam(t, t.cy, t.di, seasonId, 'Jets'),
    };
    teamsBySeason.set(seasonId, teams);
  }
  return teams;
}

// An open game of the active season, the Sharks against the Jets, submitted by Ana, so it
// awaits Bo, Cy, and Di. It is played as the clock reads, so after the season started.
async function openSeasonGame(
  t: Table,
  seasonId: string,
  body: ExhibitionGameBody = game(t),
): Promise<Game> {
  const { sharks, jets } = await teamsOf(t, seasonId);
  return submitted(t, {
    ...body,
    kind: 'season',
    seasonId,
    playedAt: clock.now().toISOString(),
    sides: { A: { teamId: sharks.id, ...body.sides.A }, B: { teamId: jets.id, ...body.sides.B } },
  });
}

function confirm(t: Table, as: Player, g: Game): Promise<Response> {
  return call(
    'POST',
    `/api/leagues/${t.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/confirm`,
    { as: as.caller, body: {} },
  );
}

async function confirmedBy(t: Table, players: Player[], g: Game): Promise<void> {
  for (const p of players) expect((await confirm(t, p, g)).status).toBe(200);
}

// Holds the season's row lock until `n` requests are queued behind it, so they run back to
// back against the same state.
async function queuedOnSeason(
  seasonId: string,
  requests: () => Array<Promise<Response>>,
): Promise<Response[]> {
  let racing: Promise<Response[]> | undefined;
  await api.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from seasons where id = ${seasonId} for update`);
    const started = requests();
    racing = Promise.all(started);
    await waitForLockWaiters(api.db, started.length);
  });
  return racing!;
}

describe('creating a season', () => {
  it('creates a draft season with the default standings config', async () => {
    const t = await table();

    const res = await createSeason(t, t.commissioner, { name: '  Fall   2026 ' });

    expect(res.status).toBe(201);
    const { season } = SeasonResponse.parse(await res.json());
    expect(season).toEqual({
      id: season.id,
      name: 'Fall 2026',
      status: 'draft',
      createdAt: NOW,
      startedAt: null,
      endedAt: null,
      finalizedAt: null,
      standingsConfig: DEFAULT_STANDINGS_CONFIG,
    });
  });

  it("lists the league's seasons to every member, newest first", async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    clock.advance(SECOND);
    const spring = await draft(t, 'Spring 2027');

    const seasons = await listSeasons(t, t.bo.caller);

    expect(seasons.map((s) => s.id)).toEqual([spring.id, fall.id]);
  });

  it("does not list another league's seasons", async () => {
    const x = await table('Basement League', 'x.example.com');
    const y = await table('Garage League', 'y.example.com');
    await draft(y);

    expect(await listSeasons(x)).toEqual([]);
  });

  it('refuses a season with an invalid name with 422 VALIDATION', async () => {
    const t = await table();

    const res = await createSeason(t, t.commissioner, { name: '   ' });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await listSeasons(t)).toEqual([]);
  });

  it(`refuses a commissioner's season past ${SEASON_CREATES_PER_HOUR} in an hour with 429`, async () => {
    const t = await table();
    for (let i = 0; i < SEASON_CREATES_PER_HOUR; i++) await draft(t, `Season ${i}`);

    const res = await createSeason(t, t.commissioner, { name: 'One too many' });

    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('RATE_LIMITED');
    expect(await listSeasons(t)).toHaveLength(SEASON_CREATES_PER_HOUR);
  });

  it('lets a commissioner create seasons again once the hour has passed', async () => {
    const t = await table();
    for (let i = 0; i < SEASON_CREATES_PER_HOUR; i++) await draft(t, `Season ${i}`);
    clock.advance(HOUR);

    const res = await createSeason(t, t.commissioner, { name: 'Next' });

    expect(res.status).toBe(201);
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();

    const res = await createSeason(t, t.bo.caller, { name: 'Fall 2026' });

    expect(res.status).toBe(403);
    expect(await listSeasons(t)).toEqual([]);
  });
});

describe('starting a season', () => {
  it('makes a draft season active from now, and audits it with the season named', async () => {
    const t = await table();
    const season = await draft(t);
    clock.advance(HOUR);

    const started = await seasonOf(await start(t, t.commissioner, season.id));

    expect(started.status).toBe('active');
    expect(started.startedAt).toBe(clock.now().toISOString());
    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'season.started',
      targetType: 'season',
      targetId: season.id,
      actorWasParticipant: false,
      season: { id: season.id, name: 'Fall 2026' },
    });
  });

  it('refuses to start a second season while one is active with 409', async () => {
    const t = await table();
    await active(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');

    const res = await start(t, t.commissioner, spring.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_ALREADY_ACTIVE');
    expect((await seasonNow(t, spring.id)).status).toBe('draft');
  });

  it('starts exactly one of two drafts started at once', async () => {
    const t = await table();
    const fall = await draft(t, 'Fall 2026');
    const spring = await draft(t, 'Spring 2027');

    const responses = await Promise.all([
      start(t, t.commissioner, fall.id),
      start(t, t.commissioner, spring.id),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const statuses = (await listSeasons(t)).map((s) => s.status).sort();
    expect(statuses).toEqual(['active', 'draft']);
  });

  it('lets the next season start once the active one has ended', async () => {
    const t = await table();
    const fall = await active(t, 'Fall 2026');
    await ended(t, fall.id);
    const spring = await draft(t, 'Spring 2027');

    const started = await seasonOf(await start(t, t.commissioner, spring.id));

    expect(started.status).toBe('active');
  });

  it('lets each league have its own active season', async () => {
    const x = await table('Basement League', 'x.example.com');
    const y = await table('Garage League', 'y.example.com');
    await active(x);

    const started = await active(y);

    expect(started.status).toBe('active');
  });

  it('returns an active season unchanged when it is started again, auditing it once', async () => {
    const t = await table();
    const season = await active(t);
    clock.advance(HOUR);

    const again = await seasonOf(await start(t, t.commissioner, season.id));

    expect(again).toEqual(season);
    expect((await auditLog(t)).map((e) => e.action)).toEqual(['season.started']);
  });

  it('refuses to restart a season that has ended with 409', async () => {
    const t = await table();
    const season = await active(t);
    await ended(t, season.id);

    const res = await start(t, t.commissioner, season.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_NOT_DRAFT');
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await start(t, t.bo.caller, season.id);

    expect(res.status).toBe(403);
    expect((await seasonNow(t, season.id)).status).toBe('draft');
  });

  it('refuses a commissioner demoted while the request waited with 403', async () => {
    const t = await table();
    const season = await draft(t);
    let pending: Promise<Response> | undefined;

    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from leagues where id = ${t.leagueId} for update`);
      pending = start(t, t.commissioner, season.id);
      await waitForLockWaiters(api.db, 1);
      await api.db.execute(
        sql`update memberships set role = 'member' where id = ${t.ana.membershipId}`,
      );
    });
    const res = await pending!;

    expect(res.status).toBe(403);
    expect((await seasonNow(t, season.id)).status).toBe('draft');
  });

  it('gives 404 for an unknown season', async () => {
    const t = await table();

    const res = await start(t, t.commissioner, randomUUID());

    expect(res.status).toBe(404);
  });
});

describe('ending a season', () => {
  it('refuses to end a draft season with 409', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await end(t, t.commissioner, season.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_NOT_ACTIVE');
    expect((await seasonNow(t, season.id)).status).toBe('draft');
  });

  it('finalizes a season with no open games as soon as it ends, and audits the end', async () => {
    const t = await table();
    const season = await active(t);
    clock.advance(DAY);

    const finished = await ended(t, season.id);

    const now = clock.now().toISOString();
    expect(finished).toMatchObject({ status: 'finalized', endedAt: now, finalizedAt: now });
    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'season.ended',
      targetType: 'season',
      targetId: season.id,
      season: { id: season.id, name: 'Fall 2026' },
    });
  });

  it('leaves a season with an open game ended but not finalized', async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);

    const finished = await ended(t, season.id);

    expect(finished).toMatchObject({ status: 'ended', finalizedAt: null });
  });

  it('returns an ended season unchanged when it is ended again, auditing it once', async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);
    const first = await ended(t, season.id);
    clock.advance(HOUR);

    const again = await ended(t, season.id);

    expect(again).toEqual(first);
    // The team approvals are the game's teams, formed after the season started.
    expect((await auditLog(t)).map((e) => e.action)).toEqual([
      'season.ended',
      'team.approved',
      'team.approved',
      'season.started',
    ]);
  });

  it('does not wait for an open exhibition game', async () => {
    const t = await table();
    const season = await active(t);
    await submitted(t);

    const finished = await ended(t, season.id);

    expect(finished.status).toBe('finalized');
  });

  it("does not wait for another season's open game", async () => {
    const t = await table();
    const fall = await active(t, 'Fall 2026');
    await openSeasonGame(t, fall.id);
    await ended(t, fall.id);
    const spring = await active(t, 'Spring 2027');

    const finished = await ended(t, spring.id);

    expect(finished.status).toBe('finalized');
  });

  it('does not wait for a game whose window has lapsed but has not been settled', async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);
    clock.advance(7 * DAY);

    const finished = await ended(t, season.id);

    expect(finished.status).toBe('finalized');
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();
    const season = await active(t);

    const res = await end(t, t.bo.caller, season.id);

    expect(res.status).toBe(403);
    expect((await seasonNow(t, season.id)).status).toBe('active');
  });
});

describe('finalizing an ended season', () => {
  it('finalizes it when its last open revision confirms', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await ended(t, season.id);
    await confirmedBy(t, [t.bo, t.cy], g);
    clock.advance(HOUR);

    await confirmedBy(t, [t.di], g);

    expect(await seasonNow(t, season.id)).toMatchObject({
      status: 'finalized',
      finalizedAt: clock.now().toISOString(),
    });
  });

  it('keeps it ended while another of its games is still open', async () => {
    const t = await table();
    const season = await active(t);
    const first = await openSeasonGame(t, season.id);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    await confirmedBy(t, [t.bo, t.cy, t.di], first);

    expect((await seasonNow(t, season.id)).status).toBe('ended');
  });

  it('keeps it ended through a correction, which leaves the game open', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await call('POST', `/api/leagues/${t.leagueId}/games/${g.id}/revisions`, {
      as: t.bo.caller,
      body: {
        baseRevisionId: g.openRevision!.id,
        playedAt: g.openRevision!.playedAt,
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 3)] },
        },
        winner: 'A',
      },
    });

    expect(res.status).toBe(201);
    expect((await seasonNow(t, season.id)).status).toBe('ended');
  });

  it('finalizes it when a commissioner force-confirms the last silent players', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await call(
      'POST',
      `/api/leagues/${t.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/force-confirm`,
      {
        as: t.commissioner,
        body: { membershipIds: [t.bo.membershipId, t.cy.membershipId, t.di.membershipId] },
      },
    );

    expect(res.status).toBe(200);
    expect((await seasonNow(t, season.id)).status).toBe('finalized');
  });

  it('keeps it ended while a rejected revision can still be corrected', async () => {
    const t = await table();
    const season = await active(t);
    // Ana and Bo win 11–10, one point short of the default win-by, sent for review.
    const g = await openSeasonGame(
      t,
      season.id,
      game(t, {
        sides: {
          A: { players: [line(t.ana, 6), line(t.bo, 5)] },
          B: { players: [line(t.cy, 5), line(t.di, 5)] },
        },
        requestOverride: true,
      }),
    );
    await ended(t, season.id);

    const res = await call(
      'POST',
      `/api/leagues/${t.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/override`,
      { as: t.commissioner, body: { decision: 'reject' } },
    );

    expect(res.status).toBe(200);
    expect((await seasonNow(t, season.id)).status).toBe('ended');
  });

  it('finalizes it when the worker expires its last open revision', async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);
    clock.advance(7 * DAY);

    expect(await sweepExpired({ db: api.db, clock })).toEqual({ expired: 1, done: true });

    expect(await seasonNow(t, season.id)).toMatchObject({
      status: 'finalized',
      finalizedAt: clock.now().toISOString(),
    });
  });

  it('finalizes it when its last two open games confirm at once', async () => {
    const t = await table();
    const season = await active(t);
    const first = await openSeasonGame(t, season.id);
    const second = await openSeasonGame(t, season.id);
    await ended(t, season.id);
    await confirmedBy(t, [t.bo, t.cy], first);
    await confirmedBy(t, [t.bo, t.cy], second);

    const responses = await queuedOnSeason(season.id, () => [
      confirm(t, t.di, first),
      confirm(t, t.di, second),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await seasonNow(t, season.id)).status).toBe('finalized');
  });

  it('waits for a confirmation sent before the window closed that is still being processed', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await ended(t, season.id);
    await confirmedBy(t, [t.bo, t.cy], g);
    clock.advance(7 * DAY - SECOND);
    let confirming: Promise<Response> | undefined;
    let patched: Response | undefined;

    // Di's confirmation reads the time 1 s before the window closes, then waits on the game
    // while the commissioner, 2 s later, changes the standings config.
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from games where id = ${g.id} for update`);
      confirming = confirm(t, t.di, g);
      await waitForLockWaiters(api.db, 1);
      clock.advance(2 * SECOND);
      patched = await patchConfig(t, t.commissioner, season.id, { minGames: 2 });
    });

    expect(patched!.status).toBe(200);
    expect((await confirming!).status).toBe(200);
    expect(await seasonNow(t, season.id)).toMatchObject({
      status: 'finalized',
      standingsConfig: { ...DEFAULT_STANDINGS_CONFIG, minGames: 2 },
    });
  });

  it('closes a lapsed game as it finalizes, so a confirmation sent before the window closed and arriving after is refused', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await ended(t, season.id);
    await confirmedBy(t, [t.bo, t.cy], g);
    clock.advance(7 * DAY + SECOND);
    let patching: Promise<Response> | undefined;
    let confirming: Promise<Response> | undefined;

    // The commissioner's change, 1 s after the window closes, finalizes the season. Holding
    // the open revision's row stops that change midway, with the game in hand. Di's
    // confirmation, which read the time 2 s earlier, then waits on the game.
    await api.db.transaction(async (tx) => {
      await tx.execute(
        sql`select 1 from game_revisions where id = ${g.openRevision!.id} for update`,
      );
      patching = patchConfig(t, t.commissioner, season.id, { minGames: 2 });
      await waitForLockWaiters(api.db, 1);
      clock.advance(-2 * SECOND);
      confirming = confirm(t, t.di, g);
      await waitForLockWaiters(api.db, 2);
    });
    const [patched, confirmed] = [await patching!, await confirming!];

    expect(patched.status).toBe(409);
    expect((await errorOf(patched)).code).toBe('SEASON_FINALIZED');
    expect(confirmed.status).toBe(409);
    expect((await errorOf(confirmed)).code).toBe('WINDOW_CLOSED');
    const [stored] = await api.db.execute<{ status: string; counted: string | null }>(
      sql`select status, confirmed_revision_id as counted from games where id = ${g.id}`,
    );
    expect(stored).toEqual({ status: 'expired', counted: null });
  });

  it('finalizes it when its last game confirms while the season is being ended', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);
    await confirmedBy(t, [t.bo, t.cy], g);

    const responses = await queuedOnSeason(season.id, () => [
      confirm(t, t.di, g),
      end(t, t.commissioner, season.id),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await seasonNow(t, season.id)).status).toBe('finalized');
  });

  it('leaves an active season active when its games confirm', async () => {
    const t = await table();
    const season = await active(t);
    const g = await openSeasonGame(t, season.id);

    await confirmedBy(t, [t.bo, t.cy, t.di], g);

    expect((await seasonNow(t, season.id)).status).toBe('active');
  });
});

describe('the standings config', () => {
  it('replaces the order and keeps the minimum games when only the order changes', async () => {
    const t = await table();
    const season = await draft(t);

    const updated = await seasonOf(
      await patchConfig(t, t.commissioner, season.id, { order: ['wins', 'point_diff'] }),
    );

    expect(updated.standingsConfig).toEqual({ order: ['wins', 'point_diff'], minGames: 0 });
    expect((await seasonNow(t, season.id)).standingsConfig).toEqual(updated.standingsConfig);
  });

  it('audits a change with the config before and after', async () => {
    const t = await table();
    const season = await active(t);

    await seasonOf(await patchConfig(t, t.commissioner, season.id, { minGames: 3 }));

    const [event] = await auditLog(t);
    expect(event).toMatchObject({
      action: 'season.standings_config_updated',
      targetType: 'season',
      targetId: season.id,
      season: { id: season.id, name: 'Fall 2026' },
      details: {
        before: DEFAULT_STANDINGS_CONFIG,
        after: { ...DEFAULT_STANDINGS_CONFIG, minGames: 3 },
      },
    });
  });

  it('writes and audits nothing when the change matches the current config', async () => {
    const t = await table();
    const season = await draft(t);

    const same = await seasonOf(await patchConfig(t, t.commissioner, season.id, { minGames: 0 }));

    expect(same).toEqual(season);
    expect(await auditLog(t)).toEqual([]);
  });

  it('refuses an invalid config with 422 VALIDATION', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await patchConfig(t, t.commissioner, season.id, { order: ['wins', 'wins'] });

    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it('can still change once the season has ended, while a game is open', async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);

    const res = await patchConfig(t, t.commissioner, season.id, { minGames: 2 });

    expect(res.status).toBe(200);
  });

  it('is locked once the season is finalized', async () => {
    const t = await table();
    const season = await active(t);
    await ended(t, season.id);

    const res = await patchConfig(t, t.commissioner, season.id, { minGames: 2 });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
    expect((await seasonNow(t, season.id)).standingsConfig).toEqual(DEFAULT_STANDINGS_CONFIG);
  });

  it("is locked once the last open game's window lapses, before anything settles it", async () => {
    const t = await table();
    const season = await active(t);
    await openSeasonGame(t, season.id);
    await ended(t, season.id);
    clock.advance(7 * DAY);

    const res = await patchConfig(t, t.commissioner, season.id, { minGames: 2 });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('SEASON_FINALIZED');
    expect(await seasonNow(t, season.id)).toMatchObject({
      status: 'finalized',
      finalizedAt: clock.now().toISOString(),
      standingsConfig: DEFAULT_STANDINGS_CONFIG,
    });
  });

  it('refuses a member who is not a commissioner with 403', async () => {
    const t = await table();
    const season = await draft(t);

    const res = await patchConfig(t, t.bo.caller, season.id, { minGames: 2 });

    expect(res.status).toBe(403);
  });
});

describe('the season a game belongs to', () => {
  it("can't be another league's", async () => {
    const x = await table('Basement League', 'x.example.com');
    const y = await table('Garage League', 'y.example.com');
    const theirs = await active(y);
    const g = await submitted(x);

    await expect(
      api.db.execute(sql`update games set kind = 'season', season_id = ${theirs.id}
                         where id = ${g.id}`),
    ).rejects.toThrow();
  });

  it('is required for a season game', async () => {
    const t = await table();
    const g = await submitted(t);

    await expect(
      api.db.execute(sql`update games set kind = 'season' where id = ${g.id}`),
    ).rejects.toThrow();
  });

  it("can't be set on an exhibition game", async () => {
    const t = await table();
    const season = await active(t);
    const g = await submitted(t);

    await expect(
      api.db.execute(sql`update games set season_id = ${season.id} where id = ${g.id}`),
    ).rejects.toThrow();
  });
});
