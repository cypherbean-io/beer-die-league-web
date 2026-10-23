import { randomUUID } from 'node:crypto';
import {
  AuditResponse,
  CreateInviteResponse,
  ErrorBody,
  type ExhibitionGameBody,
  type Game,
  GameResponse,
  InboxResponse,
  JoinResponse,
  MembersResponse,
  MeResponse,
  PartnershipStatsResponse,
  PlayerStatsResponse,
  type Season,
  SeasonResponse,
  type Team,
  TeamResponse,
  VerifyCodeResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.ts';
import { FixedClock } from '../src/clock.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

// The league is set up a day before the games are played and the accounts deleted.
const START = '2026-10-17T12:00:00.000Z';
const NOW = '2026-10-18T12:00:00.000Z';
const PLAYED_AT = '2026-10-18T11:30:00.000Z';

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;
let call: ReturnType<typeof client>;
let sent: SentMail[];

type SentMail = { to: Array<{ address: string }>; text: string };

// Real nodemailer JSON transport; every message it renders is captured.
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
  clock = new FixedClock(START);
  sent = [];
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
// the Jets. Ed is on no team.
type Setup = League & {
  ana: Player;
  bo: Player;
  cy: Player;
  di: Player;
  ed: Player;
  season: Season;
  sharks: Team;
};

// The token of a new invite link to the league.
async function inviteToken(l: League): Promise<string> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/invites`, {
    as: l.commissioner,
    body: {},
  });
  expect(res.status).toBe(201);
  const { url } = CreateInviteResponse.parse(await res.json());
  return url.slice(`${APP_ORIGIN}/join/`.length);
}

function join(token: string, as: Caller, displayName: string): Promise<Response> {
  return call('POST', `/api/invites/${token}/join`, { as, body: { displayName } });
}

// A signed-in member awaiting approval, admitted through the real invite flow.
async function pending(l: League, email: string, displayName: string): Promise<Player> {
  const caller = await signIn(api.db, clock, email);
  const joined = await join(await inviteToken(l), caller, displayName);
  expect(joined.status).toBe(201);
  return { caller, membershipId: JoinResponse.parse(await joined.json()).membership.id };
}

// Likewise, then approved by the commissioner.
async function member(l: League, email: string, displayName: string): Promise<Player> {
  const player = await pending(l, email, displayName);
  const approved = await call(
    'POST',
    `/api/leagues/${l.leagueId}/members/${player.membershipId}/approve`,
    { as: l.commissioner, body: {} },
  );
  expect(approved.status).toBe(200);
  return player;
}

const seasonsPath = (l: League) => `/api/leagues/${l.leagueId}/seasons`;

async function started(l: League, name: string): Promise<Season> {
  const created = await call('POST', seasonsPath(l), { as: l.commissioner, body: { name } });
  expect(created.status).toBe(201);
  const { id } = SeasonResponse.parse(await created.json()).season;
  const res = await call('POST', `${seasonsPath(l)}/${id}/start`, {
    as: l.commissioner,
    body: {},
  });
  expect(res.status).toBe(200);
  return SeasonResponse.parse(await res.json()).season;
}

// Proposed, accepted by the partner, and approved by the commissioner.
async function approved(
  l: League,
  proposer: Player,
  partner: Player,
  seasonId: string,
  name: string,
): Promise<Team> {
  const proposed = await call('POST', `${seasonsPath(l)}/${seasonId}/teams`, {
    as: proposer.caller,
    body: { name, partnerId: partner.membershipId },
  });
  expect(proposed.status).toBe(201);
  const team = TeamResponse.parse(await proposed.json()).team;
  for (const [as, action] of [
    [partner.caller, 'accept'],
    [l.commissioner, 'approve'],
  ] as const) {
    const res = await call('POST', `/api/leagues/${l.leagueId}/teams/${team.id}/${action}`, {
      as,
      body: {},
    });
    expect(res.status).toBe(200);
  }
  return team;
}

// A league with just its commissioner, created through the CLI as an operator would.
async function bootstrap(email: string, displayName: string): Promise<League & { ana: Player }> {
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name: `${displayName}'s League`,
    email,
    displayName,
  });
  const caller = await signIn(api.db, clock, email);
  return { leagueId, commissioner: caller, ana: { caller, membershipId } };
}

// Builds the league at START, then moves the clock to NOW.
async function setup(): Promise<Setup> {
  const l = await bootstrap('ana@example.com', 'Ana');
  const players = {
    bo: await member(l, 'bo@example.com', 'Bo'),
    cy: await member(l, 'cy@example.com', 'Cy'),
    di: await member(l, 'di@example.com', 'Di'),
    ed: await member(l, 'ed@example.com', 'Ed'),
  };
  const season = await started(l, 'Fall 2026');
  const sharks = await approved(l, l.ana, players.bo, season.id, 'Sharks');
  await approved(l, players.cy, players.di, season.id, 'Jets');
  at(NOW);
  return { ...l, ...players, season, sharks };
}

type Line = { membershipId: string; points: number; sinks: number };

const line = (p: Player, points: number): Line => ({
  membershipId: p.membershipId,
  points,
  sinks: 0,
});

// Ana and Bo beat Cy and Di 11–9, half an hour ago.
function exhibition(s: Setup): ExhibitionGameBody {
  return {
    idempotencyKey: randomUUID(),
    kind: 'exhibition',
    playedAt: PLAYED_AT,
    sides: {
      A: { players: [line(s.ana, 6), line(s.bo, 5)] },
      B: { players: [line(s.cy, 5), line(s.di, 4)] },
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

// Submitted by Cy, then confirmed by Ana, Bo, and Di.
async function counted(s: Setup): Promise<Game> {
  let g = await submitted(s, s.cy, exhibition(s));
  for (const p of [s.ana, s.bo, s.di]) {
    const res = await call(
      'POST',
      `/api/leagues/${s.leagueId}/games/${g.id}/revisions/${g.openRevision!.id}/confirm`,
      { as: p.caller, body: {} },
    );
    expect(res.status).toBe(200);
    g = GameResponse.parse(await res.json()).game;
  }
  expect(g.status).toBe('confirmed');
  return g;
}

function deleteAccount(as: Caller, body: unknown = { keepDisplayName: false }): Promise<Response> {
  return call('DELETE', '/api/me', { as, body });
}

async function deleted(p: Player, keepDisplayName = false): Promise<void> {
  const res = await deleteAccount(p.caller, { keepDisplayName });
  expect(res.status).toBe(204);
}

function getMe(as: Caller): Promise<Response> {
  return call('GET', '/api/me', { as });
}

// Mails a sign-in code to `email` through the real outbox, and returns it.
async function mailedCode(email: string): Promise<string> {
  const res = await call('POST', '/api/auth/code', { body: { email } });
  expect(res.status).toBe(202);
  await drainOutbox({
    db: api.db,
    clock,
    transport: capturingTransport,
    mailFrom: 'Beer Die League <league@app.test>',
    authSecret: api.authSecret,
    log: (entry) => api.logs.push(entry),
  });
  const code = sent.findLast((m) => m.to[0]?.address === email)?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code was mailed to that address');
  return code;
}

function verify(email: string, code: string): Promise<Response> {
  return call('POST', '/api/auth/verify', { body: { email, code, client: 'native' } });
}

type UserRow = { email: string | null; deleted_at: Date | null };

// Raw queries return timestamps as strings.
async function userRow(userId: string): Promise<UserRow> {
  const [row] = await api.db.execute<{ email: string | null; deleted_at: string | null }>(
    sql`select email, deleted_at from users where id = ${userId}`,
  );
  return { email: row!.email, deleted_at: row!.deleted_at ? new Date(row!.deleted_at) : null };
}

// How many rows of the user's sessions, queued mail, and sign-in codes are left.
async function leftovers(userId: string, email: string) {
  const [row] = await api.db.execute<{ sessions: number; mail: number; codes: number }>(
    sql`select (select count(*)::int from sessions where user_id = ${userId}) as sessions,
               (select count(*)::int from email_outbox where user_id = ${userId}) as mail,
               (select count(*)::int from auth_codes where email = ${email}) as codes`,
  );
  return row!;
}

type MembershipRow = {
  status: string;
  display_name: string;
  name_key: string;
  keep_name_on_delete: boolean;
};

async function membershipRow(membershipId: string): Promise<MembershipRow | undefined> {
  const [row] = await api.db.execute<MembershipRow>(
    sql`select status, display_name, name_key, keep_name_on_delete
        from memberships where id = ${membershipId}`,
  );
  return row;
}

async function gameStatus(gameId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from games where id = ${gameId}`,
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

async function teamStatus(teamId: string): Promise<string> {
  const [row] = await api.db.execute<{ status: string }>(
    sql`select status from season_teams where id = ${teamId}`,
  );
  return row!.status;
}

async function playerStats(l: League, as: Player) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/stats/players?scope=combined`, {
    as: as.caller,
  });
  expect(res.status).toBe(200);
  return PlayerStatsResponse.parse(await res.json()).players;
}

async function inbox(l: League, as: Player): Promise<Game[]> {
  const res = await call('GET', `/api/leagues/${l.leagueId}/inbox`, { as: as.caller });
  expect(res.status).toBe(200);
  return InboxResponse.parse(await res.json()).games;
}

describe('deleting an account', () => {
  it('erases the email, every session, sign-in codes, and queued mail', async () => {
    const s = await setup();
    const otherDevice = await signIn(api.db, clock, 'bo@example.com');
    const code = await call('POST', '/api/auth/code', { body: { email: 'bo@example.com' } });
    expect(code.status).toBe(202);
    expect(await leftovers(s.bo.caller.userId, 'bo@example.com')).toEqual({
      sessions: 2,
      mail: 1,
      codes: 1,
    });

    await deleted(s.bo);

    expect(await userRow(s.bo.caller.userId)).toEqual({ email: null, deleted_at: new Date(NOW) });
    expect(await leftovers(s.bo.caller.userId, 'bo@example.com')).toEqual({
      sessions: 0,
      mail: 0,
      codes: 0,
    });
    expect((await getMe(s.bo.caller)).status).toBe(401);
    expect((await getMe(otherDevice)).status).toBe(401);
  });

  it('clears the web session cookie', async () => {
    const s = await setup();
    const token = await api.db.transaction((tx) =>
      createSession(tx, { userId: s.bo.caller.userId, client: 'web', now: clock.now() }),
    );

    const res = await fetch(`${api.baseUrl}/api/me`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        origin: APP_ORIGIN,
        cookie: `session=${token}`,
      },
      body: JSON.stringify({ keepDisplayName: false }),
    });

    expect(res.status).toBe(204);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('session='));
    expect(cleared).toMatch(/Max-Age=0/);
  });

  it('voids their open games, which leave every inbox', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));

    await deleted(s.bo);

    expect(await gameStatus(g.id)).toBe('voided');
    expect(await inbox(s, s.di)).toEqual([]);
  });

  it('keeps their confirmed games counting, under "Deleted player #1"', async () => {
    const s = await setup();
    const g = await counted(s);

    await deleted(s.bo);

    expect(await gameStatus(g.id)).toBe('confirmed');
    const bo = (await playerStats(s, s.cy)).find((p) => p.membershipId === s.bo.membershipId);
    expect(bo).toMatchObject({
      displayName: 'Deleted player #1',
      gamesPlayed: 1,
      wins: 1,
      points: 5,
    });
    const res = await call('GET', `/api/leagues/${s.leagueId}/stats/partnerships?scope=combined`, {
      as: s.cy.caller,
    });
    expect(res.status).toBe(200);
    const pairs = PartnershipStatsResponse.parse(await res.json()).partnerships.map((p) =>
      p.players.map((x) => x.displayName).sort(),
    );
    expect(pairs).toContainEqual(['Ana', 'Deleted player #1']);
  });

  it('numbers the anonymized players of a league in turn, skipping kept names', async () => {
    const s = await setup();

    await deleted(s.bo);
    await deleted(s.di, true);
    await deleted(s.cy);

    const names = await Promise.all(
      [s.bo, s.di, s.cy].map(async (p) => (await membershipRow(p.membershipId))!.display_name),
    );
    expect(names).toEqual(['Deleted player #1', 'Di', 'Deleted player #2']);
  });

  it('frees an anonymized name for someone new', async () => {
    const s = await setup();
    await deleted(s.bo);

    const newcomer = await signIn(api.db, clock, 'bob@example.com');
    const res = await join(await inviteToken(s), newcomer, 'Bo');

    expect(res.status).toBe(201);
  });

  it('with keepDisplayName, marks the kept name as a former member', async () => {
    const s = await setup();
    await counted(s);

    await deleted(s.bo, true);

    const bo = (await playerStats(s, s.cy)).find((p) => p.membershipId === s.bo.membershipId);
    expect(bo).toMatchObject({ displayName: 'Bo', former: true });
  });

  it('with keepDisplayName, keeps the name on their games and keeps it reserved', async () => {
    const s = await setup();
    await counted(s);

    await deleted(s.bo, true);

    expect(await membershipRow(s.bo.membershipId)).toEqual({
      status: 'deleted',
      display_name: 'Bo',
      name_key: 'bo',
      keep_name_on_delete: true,
    });
    const bo = (await playerStats(s, s.cy)).find((p) => p.membershipId === s.bo.membershipId);
    expect(bo).toMatchObject({ displayName: 'Bo', gamesPlayed: 1 });
    const newcomer = await signIn(api.db, clock, 'bob@example.com');
    const res = await join(await inviteToken(s), newcomer, 'bo');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
  });

  it('takes them off their team, which stays approved for a commissioner to refill', async () => {
    const s = await setup();

    await deleted(s.bo);

    expect(await openRoster(s.sharks.id)).toEqual([s.ana.membershipId]);
    expect(await teamStatus(s.sharks.id)).toBe('approved');
  });

  it('drops them from the member list and from new games', async () => {
    const s = await setup();

    await deleted(s.bo);

    expect(await membershipRow(s.bo.membershipId)).toMatchObject({
      status: 'deleted',
      keep_name_on_delete: false,
    });
    const list = await call('GET', `/api/leagues/${s.leagueId}/members`, { as: s.commissioner });
    const ids = MembersResponse.parse(await list.json()).members.map((m) => m.id);
    expect(ids).not.toContain(s.bo.membershipId);
    const game = await submit(s, s.cy, exhibition(s));
    expect(game.status).toBe(422);
    expect(await errorCode(game)).toBe('VALIDATION');
  });

  it('is not recorded in the league log, which is for commissioner actions', async () => {
    const s = await setup();

    await deleted(s.bo);

    const res = await call('GET', `/api/leagues/${s.leagueId}/audit`, { as: s.commissioner });
    const actions = AuditResponse.parse(await res.json()).events.map((e) => e.action);
    expect(actions).not.toContain('member.removed');
    expect(actions.every((a) => a.startsWith('season.') || a.startsWith('team.'))).toBe(true);
  });

  it('deletes a membership still awaiting approval, which frees its name', async () => {
    const s = await setup();
    const zed = await pending(s, 'zed@example.com', 'Zed');

    await deleted(zed);

    expect(await membershipRow(zed.membershipId)).toBeUndefined();
    const newcomer = await signIn(api.db, clock, 'zoe@example.com');
    expect((await join(await inviteToken(s), newcomer, 'Zed')).status).toBe(201);
  });

  it('anonymizes a league they had already left', async () => {
    const s = await setup();
    const left = await call('POST', `/api/leagues/${s.leagueId}/leave`, {
      as: s.bo.caller,
      body: {},
    });
    expect(left.status).toBe(204);

    await deleted(s.bo);

    expect(await membershipRow(s.bo.membershipId)).toEqual({
      status: 'deleted',
      display_name: 'Deleted player #1',
      name_key: 'deleted player #1',
      keep_name_on_delete: false,
    });
  });

  it('lets the same email sign up again as a new, unlinked user', async () => {
    const s = await setup();
    await deleted(s.bo);

    const res = await verify('bo@example.com', await mailedCode('bo@example.com'));

    expect(res.status).toBe(200);
    const { user, token } = VerifyCodeResponse.parse(await res.json());
    expect(user.id).not.toBe(s.bo.caller.userId);
    const me = await getMe({ userId: user.id, token: token! });
    expect(MeResponse.parse(await me.json())).toEqual({
      user: { id: user.id, email: 'bo@example.com' },
      memberships: [],
    });
  });
});

describe('a commissioner deleting their account', () => {
  it('is refused for the last commissioner of a league with other members, changing nothing', async () => {
    const s = await setup();
    const g = await submitted(s, s.cy, exhibition(s));

    const res = await deleteAccount(s.ana.caller);

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('LAST_COMMISSIONER');
    expect(await userRow(s.ana.caller.userId)).toEqual({
      email: 'ana@example.com',
      deleted_at: null,
    });
    expect((await getMe(s.ana.caller)).status).toBe(200);
    expect((await membershipRow(s.ana.membershipId))!.status).toBe('approved');
    expect(await gameStatus(g.id)).toBe('pending');
  });

  it('is allowed when they are the only member of their league', async () => {
    const l = await bootstrap('ana@example.com', 'Ana');

    await deleted(l.ana);

    expect((await membershipRow(l.ana.membershipId))!.status).toBe('deleted');
  });

  it('is allowed while another commissioner remains', async () => {
    const s = await setup();
    const promoted = await call(
      'POST',
      `/api/leagues/${s.leagueId}/members/${s.bo.membershipId}/role`,
      { as: s.commissioner, body: { role: 'commissioner' } },
    );
    expect(promoted.status).toBe(200);

    await deleted(s.ana);

    expect((await membershipRow(s.ana.membershipId))!.status).toBe('deleted');
  });
});

describe('the deletion request', () => {
  it('rejects a body without keepDisplayName, or with unknown fields, with 422', async () => {
    const s = await setup();

    for (const body of [{}, { keepDisplayName: 'yes' }, { keepDisplayName: true, extra: 1 }]) {
      const res = await deleteAccount(s.bo.caller, body);
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe('VALIDATION');
    }
    expect((await getMe(s.bo.caller)).status).toBe(200);
  });

  it('requires a session', async () => {
    const res = await call('DELETE', '/api/me', { body: { keepDisplayName: false } });

    expect(res.status).toBe(401);
  });
});

describe('deletion racing other writes', () => {
  it('waits for a join in flight, then deletes the membership it created', async () => {
    const s = await setup();
    const zed = await signIn(api.db, clock, 'zed@example.com');
    const token = await inviteToken(s);

    let joining: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // The join's insert waits on the league row for its foreign key, holding Zed's user row.
      await tx.execute(sql`select 1 from leagues where id = ${s.leagueId} for update`);
      joining = join(token, zed, 'Zed');
      await waitForLockWaiters(api.db, 1);
      deleting = deleteAccount(zed);
      await waitForLockWaiters(api.db, 2);
    });

    const joined = await joining!;
    expect(joined.status).toBe(201);
    expect((await deleting!).status).toBe(204);
    const { membership } = JoinResponse.parse(await joined.json());
    expect(await membershipRow(membership.id)).toBeUndefined();
  });

  it('refuses a join that reaches the account while it is being deleted', async () => {
    const s = await setup();
    const other = await bootstrap('zoe@example.com', 'Zoe');
    const token = await inviteToken(other);

    let deleting: Promise<Response> | undefined;
    let joining: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // The deletion has marked Bo's account and waits on his membership.
      await tx.execute(sql`select 1 from memberships where id = ${s.bo.membershipId} for update`);
      deleting = deleteAccount(s.bo.caller);
      await waitForLockWaiters(api.db, 1);
      joining = join(token, s.bo.caller, 'Bo');
      await waitForLockWaiters(api.db, 2);
    });

    expect((await deleting!).status).toBe(204);
    expect((await joining!).status).toBe(401);
    const [row] = await api.db.execute<{ n: number }>(
      sql`select count(*)::int as n from memberships where league_id = ${other.leagueId}`,
    );
    expect(row!.n).toBe(1);
  });

  it('waits for a game submission that mails them, then voids the game and the mail', async () => {
    const s = await setup();

    let submitting: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // Di joined last, so the submission holds Bo's membership FOR SHARE and waits on Di's.
      // It then mails Bo, which needs his user row.
      await tx.execute(sql`select 1 from memberships where id = ${s.di.membershipId} for update`);
      submitting = submit(s, s.cy, exhibition(s));
      await waitForLockWaiters(api.db, 1);
      deleting = deleteAccount(s.bo.caller);
      await waitForLockWaiters(api.db, 2);
    });

    const res = await submitting!;
    expect(res.status).toBe(201);
    expect((await deleting!).status).toBe(204);
    const { game } = GameResponse.parse(await res.json());
    expect(await gameStatus(game.id)).toBe('voided');
    expect((await leftovers(s.bo.caller.userId, 'bo@example.com')).mail).toBe(0);
  });

  it('erases mail queued for them by a write that commits after the deletion', async () => {
    const s = await setup();
    const promoted = await call(
      'POST',
      `/api/leagues/${s.leagueId}/members/${s.bo.membershipId}/role`,
      { as: s.commissioner, body: { role: 'commissioner' } },
    );
    expect(promoted.status).toBe(200);
    const code = await call('POST', '/api/auth/code', { body: { email: 'bo@example.com' } });
    expect(code.status).toBe(202);
    const zed = await signIn(api.db, clock, 'zed@example.com');
    const token = await inviteToken(s);

    let deleting: Promise<Response> | undefined;
    let joining: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // The deletion has cleared Bo's email and waits to erase his mail. Zed's join read Bo as
      // a commissioner before that, and its mail to him waits on his account.
      await tx.execute(
        sql`select 1 from email_outbox where user_id = ${s.bo.caller.userId} for update`,
      );
      deleting = deleteAccount(s.bo.caller);
      await waitForLockWaiters(api.db, 1);
      joining = join(token, zed, 'Zed');
      await waitForLockWaiters(api.db, 2);
    });
    expect((await deleting!).status).toBe(204);
    expect((await joining!).status).toBe(201);

    await drainOutbox({
      db: api.db,
      clock,
      transport: capturingTransport,
      mailFrom: 'Beer Die League <league@app.test>',
      authSecret: api.authSecret,
      log: (entry) => api.logs.push(entry),
    });

    expect((await leftovers(s.bo.caller.userId, 'bo@example.com')).mail).toBe(0);
  });

  it('lets a sign-in in flight finish as a new, unlinked user', async () => {
    const s = await setup();
    const code = await mailedCode('bo@example.com');

    let deleting: Promise<Response> | undefined;
    let verifying: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      // The deletion has marked Bo's account and waits on his membership; the sign-in holds
      // his code and waits on his account.
      await tx.execute(sql`select 1 from memberships where id = ${s.bo.membershipId} for update`);
      deleting = deleteAccount(s.bo.caller);
      await waitForLockWaiters(api.db, 1);
      verifying = verify('bo@example.com', code);
      await waitForLockWaiters(api.db, 2);
    });

    expect((await deleting!).status).toBe(204);
    const res = await verifying!;
    expect(res.status).toBe(200);
    const { user } = VerifyCodeResponse.parse(await res.json());
    expect(user.id).not.toBe(s.bo.caller.userId);
    expect((await userRow(s.bo.caller.userId)).email).toBeNull();
  });
});
