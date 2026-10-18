import { randomBytes } from 'node:crypto';
import {
  CreateInviteResponse,
  ErrorBody,
  InvitesResponse,
  JoinResponse,
  LeagueResponse,
  MembersResponse,
  MemberResponse,
  MeResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { FixedClock } from '../src/clock.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const INVITE_TTL = 14 * DAY;

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
  clock = new FixedClock('2026-10-18T12:00:00.000Z');
  sent = [];
  api = await startApi(database.url, { clock });
  call = client(api.baseUrl);
  await api.db.execute(
    sql`truncate table invites, memberships, leagues, email_outbox, sessions, auth_codes, rate_limits, users cascade`,
  );
});

afterEach(async () => {
  await api.stop();
});

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

// Waits (bounded) until `n` backends in this test's database are blocked on a lock.
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await api.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row!.waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${n} backends ever waited on a lock`);
}

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

type League = { leagueId: string; commissioner: Caller; commissionerMembershipId: string };

async function league(name: string, email: string, displayName: string): Promise<League> {
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName,
  });
  return {
    leagueId,
    commissioner: await signIn(api.db, clock, email),
    commissionerMembershipId: membershipId,
  };
}

async function invite(l: League): Promise<{ id: string; token: string; url: string }> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/invites`, {
    as: l.commissioner,
    body: {},
  });
  expect(res.status).toBe(201);
  const { invite, url } = CreateInviteResponse.parse(await res.json());
  return { id: invite.id, url, token: url.slice(`${APP_ORIGIN}/join/`.length) };
}

function join(token: string, as: Caller, displayName: string): Promise<Response> {
  return call('POST', `/api/invites/${token}/join`, { as, body: { displayName } });
}

async function joined(token: string, as: Caller, displayName: string): Promise<string> {
  const res = await join(token, as, displayName);
  expect(res.status).toBe(201);
  return JoinResponse.parse(await res.json()).membership.id;
}

async function approve(l: League, membershipId: string): Promise<void> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/approve`, {
    as: l.commissioner,
    body: {},
  });
  expect(res.status).toBe(200);
}

// A signed-in, approved, non-commissioner member.
async function member(l: League, email: string, displayName: string) {
  const caller = await signIn(api.db, clock, email);
  const { token } = await invite(l);
  const membershipId = await joined(token, caller, displayName);
  await approve(l, membershipId);
  return { caller, membershipId };
}

function setRole(l: League, as: Caller, membershipId: string, role: string) {
  return call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/role`, {
    as,
    body: { role },
  });
}

async function me(as: Caller) {
  const res = await call('GET', '/api/me', { as });
  expect(res.status).toBe(200);
  return MeResponse.parse(await res.json());
}

async function members(l: League, as: Caller) {
  const res = await call('GET', `/api/leagues/${l.leagueId}/members`, { as });
  expect(res.status).toBe(200);
  return MembersResponse.parse(await res.json()).members;
}

describe('league bootstrap', () => {
  it('lets the CLI-created commissioner read the league with default rules', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const res = await call('GET', `/api/leagues/${l.leagueId}`, { as: l.commissioner });

    expect(res.status).toBe(200);
    expect(LeagueResponse.parse(await res.json()).league).toEqual({
      id: l.leagueId,
      name: 'Basement League',
      rules: { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false },
      confirmationWindowDays: 7,
      exhibitionCorrectionWindowDays: 30,
    });
  });

  it('lists the league on the commissioner’s /me as an approved commissioner', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const { memberships } = await me(l.commissioner);

    expect(memberships).toEqual([
      {
        id: l.commissionerMembershipId,
        leagueId: l.leagueId,
        leagueName: 'Basement League',
        displayName: 'Ana',
        role: 'commissioner',
        status: 'approved',
      },
    ]);
  });

  it('lists no memberships for a user who has not joined a league', async () => {
    const bo = await signIn(api.db, clock, 'bo@example.com');

    expect((await me(bo)).memberships).toEqual([]);
  });
});

describe('invites', () => {
  it('returns a join link once and stores only the token hash', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const { token, url } = await invite(l);

    expect(url).toMatch(new RegExp(`^${APP_ORIGIN}/join/[A-Za-z0-9_-]{43}$`));
    const rows = await api.db.execute(sql`select * from invites`);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('expires 14 days after creation', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const res = await call('POST', `/api/leagues/${l.leagueId}/invites`, {
      as: l.commissioner,
      body: {},
    });

    const { invite } = CreateInviteResponse.parse(await res.json());
    expect(new Date(invite.expiresAt).getTime()).toBe(clock.now().getTime() + INVITE_TTL);
  });

  it('lists active invites without their tokens', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const created = await invite(l);

    const res = await call('GET', `/api/leagues/${l.leagueId}/invites`, { as: l.commissioner });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(InvitesResponse.parse(JSON.parse(body)).invites.map((i) => i.id)).toEqual([created.id]);
    expect(body).not.toContain(created.token);
  });

  it('accepts a join 1 s before the invite expires', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    clock.advance(INVITE_TTL - SECOND);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(201);
  });

  it('rejects a join at the moment the invite expires', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    clock.advance(INVITE_TTL);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');
  });

  it('rejects a join through a revoked invite', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { id, token } = await invite(l);
    const revoke = await call('DELETE', `/api/leagues/${l.leagueId}/invites/${id}`, {
      as: l.commissioner,
    });
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Bo');

    expect(revoke.status).toBe(204);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');
  });

  it('drops a revoked invite from the active list', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { id } = await invite(l);
    await call('DELETE', `/api/leagues/${l.leagueId}/invites/${id}`, { as: l.commissioner });

    const res = await call('GET', `/api/leagues/${l.leagueId}/invites`, { as: l.commissioner });

    expect(InvitesResponse.parse(await res.json()).invites).toEqual([]);
  });

  it('treats revoking an already revoked invite as a no-op', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { id } = await invite(l);
    await call('DELETE', `/api/leagues/${l.leagueId}/invites/${id}`, { as: l.commissioner });

    const res = await call('DELETE', `/api/leagues/${l.leagueId}/invites/${id}`, {
      as: l.commissioner,
    });

    expect(res.status).toBe(204);
  });

  it.each([
    ['an unknown token', randomBytes(32).toString('base64url')],
    ['a malformed token', 'not-a-token'],
  ])('rejects a join through %s', async (_label, token) => {
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('INVITE_INVALID');
  });

  it('requires a session to join', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);

    const res = await call('POST', `/api/invites/${token}/join`, { body: { displayName: 'Bo' } });

    expect(res.status).toBe(401);
  });
});

describe('joining and approval', () => {
  it('creates a pending membership that gets 404 on league data', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(201);
    expect(JoinResponse.parse(await res.json()).membership).toMatchObject({
      leagueId: l.leagueId,
      displayName: 'Bo',
      role: 'member',
      status: 'pending',
    });
    expect((await call('GET', `/api/leagues/${l.leagueId}`, { as: bo })).status).toBe(404);
    expect((await call('GET', `/api/leagues/${l.leagueId}/members`, { as: bo })).status).toBe(404);
  });

  it('shows the pending membership on /me', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    await joined(token, bo, 'Bo');

    const { memberships } = await me(bo);

    expect(memberships).toMatchObject([
      { leagueId: l.leagueId, leagueName: 'Basement League', status: 'pending' },
    ]);
  });

  it('grants access to league data once a commissioner approves', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    const membershipId = await joined(token, bo, 'Bo');

    const res = await call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/approve`, {
      as: l.commissioner,
      body: {},
    });

    expect(res.status).toBe(200);
    expect(MemberResponse.parse(await res.json()).member).toMatchObject({
      id: membershipId,
      status: 'approved',
    });
    expect((await call('GET', `/api/leagues/${l.leagueId}`, { as: bo })).status).toBe(200);
    expect((await me(bo)).memberships).toMatchObject([{ status: 'approved' }]);
  });

  it('refuses to approve a member who is not pending', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await call(
      'POST',
      `/api/leagues/${l.leagueId}/members/${bo.membershipId}/approve`,
      { as: l.commissioner, body: {} },
    );

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NOT_PENDING');
  });

  it('removes a rejected pending membership and frees its name', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    const membershipId = await joined(token, bo, 'Bo');

    const res = await call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/reject`, {
      as: l.commissioner,
      body: {},
    });
    const cy = await signIn(api.db, clock, 'cy@example.com');

    expect(res.status).toBe(204);
    expect((await me(bo)).memberships).toEqual([]);
    expect((await join(token, cy, 'Bo')).status).toBe(201);
  });

  it('refuses to reject a member who is already approved', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await call('POST', `/api/leagues/${l.leagueId}/members/${bo.membershipId}/reject`, {
      as: l.commissioner,
      body: {},
    });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NOT_PENDING');
  });

  it('refuses a second join by someone who already has a membership', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    await joined(token, bo, 'Bo');

    const again = await join(token, bo, 'Bobby');
    const commissioner = await join(token, l.commissioner, 'Anabel');

    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('ALREADY_MEMBER');
    expect(commissioner.status).toBe(409);
    expect(await errorCode(commissioner)).toBe('ALREADY_MEMBER');
  });

  it('rejects an invalid display name with 422 VALIDATION', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, '<img src=x onerror=alert(1)>');

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
  });

  it('rejects unknown fields in the join body', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await call('POST', `/api/invites/${token}/join`, {
      as: bo,
      body: { displayName: 'Bo', role: 'commissioner' },
    });

    expect(res.status).toBe(422);
  });

  it('stores the display name NFKC-normalized', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Ｂｏ');

    expect(JoinResponse.parse(await res.json()).membership.displayName).toBe('Bo');
  });
});

describe('display names', () => {
  it.each(['ana', 'ANA', 'Ａｎａ', '  Ana  '])(
    'treats %j as taken when "Ana" is a member',
    async (name) => {
      const l = await league('Basement League', 'ana@example.com', 'Ana');
      const { token } = await invite(l);
      const bo = await signIn(api.db, clock, 'bo@example.com');

      const res = await join(token, bo, name);

      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe('NAME_TAKEN');
    },
  );

  it('reserves a pending member’s name', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    await joined(token, await signIn(api.db, clock, 'bo@example.com'), 'Bo');

    const res = await join(token, await signIn(api.db, clock, 'cy@example.com'), 'bo');

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
  });

  it('lets one of two concurrent joins with the same name win, and refuses the other', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    const cy = await signIn(api.db, clock, 'cy@example.com');

    const results = await Promise.all([join(token, bo, 'Dee'), join(token, cy, 'dee')]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('allows the same name in a different league', async () => {
    await league('Basement League', 'ana@example.com', 'Ana');
    const other = await league('Garage League', 'zed@example.com', 'Zed');
    const { token } = await invite(other);
    const bo = await signIn(api.db, clock, 'bo@example.com');

    const res = await join(token, bo, 'Ana');

    expect(res.status).toBe(201);
  });
});

describe('member list', () => {
  it('shows a commissioner pending members with their email', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const membershipId = await joined(token, await signIn(api.db, clock, 'bo@example.com'), 'Bo');

    const list = await members(l, l.commissioner);

    expect(list).toContainEqual({
      id: membershipId,
      displayName: 'Bo',
      role: 'member',
      status: 'pending',
      email: 'bo@example.com',
    });
  });

  it('never shows an approved member’s email, even to a commissioner', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    await member(l, 'bo@example.com', 'Bo');

    const list = await members(l, l.commissioner);

    expect(list.every((m) => m.email === undefined)).toBe(true);
    expect(list.map((m) => m.displayName).sort()).toEqual(['Ana', 'Bo']);
  });

  it('hides pending members from a non-commissioner', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');
    const { token } = await invite(l);
    await joined(token, await signIn(api.db, clock, 'cy@example.com'), 'Cy');

    const list = await members(l, bo.caller);

    expect(list.map((m) => m.status)).toEqual(['approved', 'approved']);
    expect(JSON.stringify(list)).not.toContain('cy@example.com');
  });
});

describe('roles', () => {
  it('lets a commissioner promote a member, who then has commissioner access', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await setRole(l, l.commissioner, bo.membershipId, 'commissioner');

    expect(res.status).toBe(200);
    expect(MemberResponse.parse(await res.json()).member.role).toBe('commissioner');
    const invites = await call('GET', `/api/leagues/${l.leagueId}/invites`, { as: bo.caller });
    expect(invites.status).toBe(200);
  });

  it('refuses to let the last commissioner demote themselves', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const res = await setRole(l, l.commissioner, l.commissionerMembershipId, 'member');

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('LAST_COMMISSIONER');
    expect((await me(l.commissioner)).memberships[0]!.role).toBe('commissioner');
  });

  it('lets a commissioner step down while another commissioner remains', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');
    await setRole(l, l.commissioner, bo.membershipId, 'commissioner');

    const res = await setRole(l, l.commissioner, l.commissionerMembershipId, 'member');

    expect(res.status).toBe(200);
    const invites = await call('GET', `/api/leagues/${l.leagueId}/invites`, {
      as: l.commissioner,
    });
    expect(invites.status).toBe(403);
  });

  it('leaves exactly one commissioner when two demote each other concurrently', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');
    await setRole(l, l.commissioner, bo.membershipId, 'commissioner');

    // Hold both rows so the two demotions are in flight together, then release them once
    // Postgres reports both requests waiting on a lock. Without this, one request usually
    // finishes before the other starts and the race is never exercised.
    let demotions: Promise<Response[]> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from memberships where id in (${l.commissionerMembershipId}, ${bo.membershipId}) for update`,
      );
      demotions = Promise.all([
        setRole(l, l.commissioner, bo.membershipId, 'member'),
        setRole(l, bo.caller, l.commissionerMembershipId, 'member'),
      ]);
      await waitForLockWaiters(2);
    });
    const statuses = (await demotions!).map((r) => r.status).sort();

    const list = await members(l, l.commissioner);
    expect(list.filter((m) => m.role === 'commissioner')).toHaveLength(1);
    expect(statuses).toEqual([200, 403]);
  });

  it('refuses to change the role of a pending member', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const membershipId = await joined(token, await signIn(api.db, clock, 'bo@example.com'), 'Bo');

    const res = await setRole(l, l.commissioner, membershipId, 'commissioner');

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NOT_APPROVED');
  });

  it('rejects an unknown role with 422 VALIDATION', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await setRole(l, l.commissioner, bo.membershipId, 'owner');

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
  });
});

// Every league route, with the ids it needs. The first test checks this table against the
// app's registered routes, so a new league route can't skip the tenancy checks below.
type Ids = { leagueId: string; mid: string; iid: string };
type Route = { method: string; path: string; commissioner: boolean; body?: unknown };

const LEAGUE_ROUTES: Route[] = [
  { method: 'GET', path: '/api/leagues/:leagueId', commissioner: false },
  { method: 'GET', path: '/api/leagues/:leagueId/members', commissioner: false },
  {
    method: 'POST',
    path: '/api/leagues/:leagueId/members/:mid/approve',
    commissioner: true,
    body: {},
  },
  {
    method: 'POST',
    path: '/api/leagues/:leagueId/members/:mid/reject',
    commissioner: true,
    body: {},
  },
  {
    method: 'POST',
    path: '/api/leagues/:leagueId/members/:mid/role',
    commissioner: true,
    body: { role: 'commissioner' },
  },
  { method: 'POST', path: '/api/leagues/:leagueId/invites', commissioner: true, body: {} },
  { method: 'GET', path: '/api/leagues/:leagueId/invites', commissioner: true },
  { method: 'DELETE', path: '/api/leagues/:leagueId/invites/:iid', commissioner: true },
];

function fill(path: string, ids: Ids): string {
  return path.replace(/:(leagueId|mid|iid)/g, (_m, key: keyof Ids) => ids[key]);
}

function callRoute(route: Route, ids: Ids, as: Caller): Promise<Response> {
  return call(route.method, fill(route.path, ids), { as, body: route.body });
}

// League Y with a pending member and an active invite, so every route has a real target.
async function leagueWithTargets(): Promise<{ y: League; ids: Ids }> {
  const y = await league('Garage League', 'yan@example.com', 'Yan');
  const { id: iid, token } = await invite(y);
  const mid = await joined(token, await signIn(api.db, clock, 'pat@example.com'), 'Pat');
  return { y, ids: { leagueId: y.leagueId, mid, iid } };
}

describe('tenancy', () => {
  it('covers every registered league route in the route table', () => {
    const app = createApp({
      db: api.db,
      clock,
      config: { authSecret: api.authSecret, appOrigin: APP_ORIGIN },
      log: () => {},
    });

    const registered = app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/leagues/:leagueId'))
      .map((r) => `${r.method} ${r.path}`);

    expect(new Set(registered)).toEqual(new Set(LEAGUE_ROUTES.map((r) => `${r.method} ${r.path}`)));
  });

  it.each(LEAGUE_ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "gives a commissioner of league X 404 on league Y's resource: %s",
    async (_label, route) => {
      const x = await league('Basement League', 'ana@example.com', 'Ana');
      const { y, ids } = await leagueWithTargets();

      const res = await callRoute(route, ids, x.commissioner);
      // Control: the same request by Y's own commissioner finds the resource.
      const control = await callRoute(route, ids, y.commissioner);

      expect(res.status).toBe(404);
      expect(control.status).not.toBe(404);
    },
  );

  it.each(
    LEAGUE_ROUTES.filter((r) => /:(mid|iid)\b/.test(r.path)).map(
      (r) => [`${r.method} ${r.path}`, r] as const,
    ),
  )(
    "gives X's commissioner 404 for Y's member or invite named under X's own path: %s",
    async (_label, route) => {
      const x = await league('Basement League', 'ana@example.com', 'Ana');
      const { ids } = await leagueWithTargets();

      const res = await callRoute(route, { ...ids, leagueId: x.leagueId }, x.commissioner);

      expect(res.status).toBe(404);
    },
  );

  it.each(LEAGUE_ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'gives a signed-in user with no membership 404: %s',
    async (_label, route) => {
      const { ids } = await leagueWithTargets();
      const stranger = await signIn(api.db, clock, 'stranger@example.com');

      const res = await callRoute(route, ids, stranger);

      expect(res.status).toBe(404);
    },
  );

  it.each(
    LEAGUE_ROUTES.filter((r) => r.commissioner).map((r) => [`${r.method} ${r.path}`, r] as const),
  )('gives a non-commissioner member 403 on a commissioner route: %s', async (_label, route) => {
    const { y, ids } = await leagueWithTargets();
    const bo = await member(y, 'bo@example.com', 'Bo');

    const res = await callRoute(route, ids, bo.caller);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
  });

  it.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000'])(
    'gives 404 for league id %j',
    async (leagueId) => {
      const ana = await signIn(api.db, clock, 'ana@example.com');

      const res = await call('GET', `/api/leagues/${leagueId}`, { as: ana });

      expect(res.status).toBe(404);
    },
  );

  it('gives 404 for a malformed member id', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const res = await call('POST', `/api/leagues/${l.leagueId}/members/not-a-uuid/approve`, {
      as: l.commissioner,
      body: {},
    });

    expect(res.status).toBe(404);
  });

  it('requires a session on league routes', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');

    const res = await call('GET', `/api/leagues/${l.leagueId}`);

    expect(res.status).toBe(401);
  });
});

describe('member-pending email', () => {
  it('mails opted-in commissioners the joiner’s name and a link, and nothing else', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await member(l, 'bo@example.com', 'Bo');
    await setRole(l, l.commissioner, bo.membershipId, 'commissioner');
    await api.db.execute(
      sql`update memberships set email_notifications = false where id = ${bo.membershipId}`,
    );
    await drain();
    sent = [];
    const { token } = await invite(l);

    await joined(token, await signIn(api.db, clock, 'cyrus@example.com'), 'Cyrus');
    await drain();

    expect(sent.map((m) => m.to[0]!.address)).toEqual(['ana@example.com']);
    const [mail] = sent;
    expect(mail!.subject).toBe('A new member is awaiting approval');
    expect(mail!.text).toContain('Cyrus');
    expect(mail!.text).toContain(`${APP_ORIGIN}/members`);
    expect(mail!.text).not.toContain(token);
    expect(mail!.text).not.toContain('cyrus@example.com');
  });

  it('does not mail the member who joined', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);

    await joined(token, await signIn(api.db, clock, 'bo@example.com'), 'Bo');
    await drain();

    expect(sent.map((m) => m.to[0]!.address)).not.toContain('bo@example.com');
  });

  it('wipes the joiner’s name from the outbox once the mail is sent', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    await joined(token, await signIn(api.db, clock, 'bo@example.com'), 'Bartholomew');

    await drain();

    const rows = await api.db.execute<{ params: unknown; sent_at: Date | null }>(
      sql`select params, sent_at from email_outbox where template = 'member_pending'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).not.toBeNull();
    expect(rows[0]!.params).toEqual({});
  });
});

describe('join rate limit', () => {
  // Each refused join tells the caller whether a name is taken, so an invite holder who
  // isn't approved yet can't probe the roster without limit.
  it('refuses the 11th join attempt by one user within an hour', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    for (let i = 0; i < 10; i++) expect((await join(token, bo, 'Ana')).status).toBe(409);

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('allows joining again once the hour has passed', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const bo = await signIn(api.db, clock, 'bo@example.com');
    for (let i = 0; i < 10; i++) await join(randomBytes(32).toString('base64url'), bo, 'Bo');
    clock.advance(60 * 60 * SECOND);
    const { token } = await invite(l);

    const res = await join(token, bo, 'Bo');

    expect(res.status).toBe(201);
  });

  it('limits each user separately', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    for (let i = 0; i < 10; i++) await join(token, bo, 'Ana');

    const res = await join(token, await signIn(api.db, clock, 'cy@example.com'), 'Cy');

    expect(res.status).toBe(201);
  });
});

describe('membership logging', () => {
  it('logs route templates but never invite tokens, display names, or emails', async () => {
    const l = await league('Basement League', 'ana@example.com', 'Ana');
    const { token } = await invite(l);
    const bo = await signIn(api.db, clock, 'bo@example.com');
    const membershipId = await joined(token, bo, 'Bartholomew');
    await approve(l, membershipId);
    await join(token, await signIn(api.db, clock, 'cy@example.com'), 'bartholomew');

    const logged = JSON.stringify(api.logs);
    expect(api.logs).toContainEqual(expect.objectContaining({ route: '/api/invites/:token/join' }));
    expect(api.logs).toContainEqual(
      expect.objectContaining({ route: '/api/leagues/:leagueId/members/:mid/approve' }),
    );
    for (const secret of [
      token,
      'Bartholomew',
      'bartholomew',
      'ana@example.com',
      'bo@example.com',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
