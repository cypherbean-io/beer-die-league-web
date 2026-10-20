import {
  type AuditEvent,
  AuditResponse,
  CreateInviteResponse,
  ErrorBody,
  JoinResponse,
  LeagueResponse,
} from '@beer-die/core';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
import { type Caller, client, createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const DEFAULT_RULES = { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false };
const DEFAULT_SETTINGS = { confirmationWindowDays: 7, exhibitionCorrectionWindowDays: 30 };

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
  clock = new FixedClock('2026-10-18T12:00:00.000Z');
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

type League = { leagueId: string; commissioner: Caller; commissionerMembershipId: string };

async function league(name = 'Basement League', email = 'ana@example.com'): Promise<League> {
  const { leagueId, membershipId } = await createLeague(api.db, clock, {
    name,
    email,
    displayName: email === 'ana@example.com' ? 'Ana' : 'Yan',
  });
  return {
    leagueId,
    commissioner: await signIn(api.db, clock, email),
    commissionerMembershipId: membershipId,
  };
}

// A signed-in, approved, non-commissioner member, admitted through the real invite flow.
async function member(l: League, email: string, displayName: string) {
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

async function promote(l: League, membershipId: string): Promise<void> {
  const res = await call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/role`, {
    as: l.commissioner,
    body: { role: 'commissioner' },
  });
  expect(res.status).toBe(200);
}

function patchRules(l: League, as: Caller, body: unknown): Promise<Response> {
  return call('PATCH', `/api/leagues/${l.leagueId}/rules`, { as, body });
}

function patchSettings(l: League, as: Caller, body: unknown): Promise<Response> {
  return call('PATCH', `/api/leagues/${l.leagueId}/settings`, { as, body });
}

async function getLeague(l: League, as: Caller = l.commissioner) {
  const res = await call('GET', `/api/leagues/${l.leagueId}`, { as });
  expect(res.status).toBe(200);
  return LeagueResponse.parse(await res.json()).league;
}

async function auditLog(l: League, as: Caller = l.commissioner, query = '') {
  const res = await call('GET', `/api/leagues/${l.leagueId}/audit${query ? `?${query}` : ''}`, {
    as,
  });
  expect(res.status).toBe(200);
  return AuditResponse.parse(await res.json());
}

function targetScoresAfter(events: AuditEvent[]): Array<number | null> {
  return events.map((e) =>
    e.action === 'league.rules_updated' ? e.details.after.targetScore : null,
  );
}

describe('rules', () => {
  it('lets a commissioner change every rule at once', async () => {
    const l = await league();
    const rules = { targetScore: 21, winBy: 1, sinkPoints: 3, sinkEndsGame: true };

    const res = await patchRules(l, l.commissioner, rules);

    expect(res.status).toBe(200);
    expect(LeagueResponse.parse(await res.json()).league.rules).toEqual(rules);
    expect((await getLeague(l)).rules).toEqual(rules);
  });

  it('changes only the rules named in the patch', async () => {
    const l = await league();

    await patchRules(l, l.commissioner, { winBy: 1 });

    expect((await getLeague(l)).rules).toEqual({ ...DEFAULT_RULES, winBy: 1 });
  });

  it('leaves the settings alone when the rules change', async () => {
    const l = await league();

    await patchRules(l, l.commissioner, { targetScore: 21 });

    expect(await getLeague(l)).toMatchObject(DEFAULT_SETTINGS);
  });

  it.each([
    ['the lowest', { targetScore: 1, winBy: 1, sinkPoints: 0 }],
    ['the highest', { targetScore: 99, winBy: 99, sinkPoints: 99 }],
  ])('accepts %s values each rule allows', async (_label, rules) => {
    const l = await league();

    const res = await patchRules(l, l.commissioner, rules);

    expect(res.status).toBe(200);
    expect((await getLeague(l)).rules).toMatchObject(rules);
  });

  it('records the change in the audit log with the rules before and after', async () => {
    const l = await league();
    clock.advance(5 * SECOND);

    await patchRules(l, l.commissioner, { targetScore: 21, sinkPoints: 3 });

    const { events } = await auditLog(l);
    expect(events).toEqual([
      {
        id: expect.any(String),
        createdAt: '2026-10-18T12:00:05.000Z',
        actor: { membershipId: l.commissionerMembershipId, displayName: 'Ana' },
        actorWasParticipant: false,
        action: 'league.rules_updated',
        targetType: 'league',
        targetId: l.leagueId,
        details: {
          before: DEFAULT_RULES,
          after: { ...DEFAULT_RULES, targetScore: 21, sinkPoints: 3 },
        },
      },
    ]);
  });

  it('writes no audit entry for a patch that changes nothing', async () => {
    const l = await league();

    const res = await patchRules(l, l.commissioner, { targetScore: 11, winBy: 2 });

    expect(res.status).toBe(200);
    expect((await auditLog(l)).events).toEqual([]);
  });

  it('refuses a member who is not a commissioner, leaving the rules and the log untouched', async () => {
    const l = await league();
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await patchRules(l, bo.caller, { targetScore: 21 });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
    expect((await getLeague(l)).rules).toEqual(DEFAULT_RULES);
    expect((await auditLog(l)).events).toEqual([]);
  });

  it.each([
    ['an empty patch', {}],
    ['a target score of 0', { targetScore: 0 }],
    ['a target score of 100', { targetScore: 100 }],
    ['a fractional win-by', { winBy: 1.5 }],
    ['negative sink points', { sinkPoints: -1 }],
    ['a setting', { confirmationWindowDays: 3 }],
    ['an unknown field', { targetScore: 21, leagueId: '0199f3a2-5c1e-7a00-8000-000000000000' }],
  ])('rejects %s with 422 VALIDATION and changes nothing', async (_label, body) => {
    const l = await league();

    const res = await patchRules(l, l.commissioner, body);

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
    expect((await getLeague(l)).rules).toEqual(DEFAULT_RULES);
  });

  it('refuses the edit of a commissioner demoted while it waited for the league lock', async () => {
    const l = await league();
    const bo = await member(l, 'bo@example.com', 'Bo');
    await promote(l, bo.membershipId);

    // Hold the league row so the edit has passed the membership middleware (as a
    // commissioner) and is waiting on the lock when the demotion commits.
    let edit: Promise<Response> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select id from leagues where id = ${l.leagueId} for update`);
      edit = patchRules(l, bo.caller, { targetScore: 21 });
      await waitForLockWaiters(api.db, 1);
      await tx.execute(sql`update memberships set role = 'member' where id = ${bo.membershipId}`);
    });
    const res = await edit!;

    expect(res.status).toBe(403);
    expect((await getLeague(l)).rules).toEqual(DEFAULT_RULES);
    expect((await auditLog(l)).events).toEqual([]);
  });

  it('serializes concurrent edits, so each audit entry records the rules it replaced', async () => {
    const l = await league();

    let edits: Promise<Response[]> | undefined;
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`select id from leagues where id = ${l.leagueId} for update`);
      edits = Promise.all([
        patchRules(l, l.commissioner, { targetScore: 15 }),
        patchRules(l, l.commissioner, { targetScore: 21 }),
      ]);
      await waitForLockWaiters(api.db, 2);
    });
    const statuses = (await edits!).map((r) => r.status);

    expect(statuses).toEqual([200, 200]);
    const [first, second] = (await auditLog(l)).events
      .toReversed()
      .map((e) => (e.action === 'league.rules_updated' ? e.details : null));
    expect(first!.before).toEqual(DEFAULT_RULES);
    expect(second!.before).toEqual(first!.after);
    expect((await getLeague(l)).rules).toEqual(second!.after);
  });
});

describe('settings', () => {
  it('lets a commissioner change both windows at once', async () => {
    const l = await league();
    const settings = { confirmationWindowDays: 3, exhibitionCorrectionWindowDays: 14 };

    const res = await patchSettings(l, l.commissioner, settings);

    expect(res.status).toBe(200);
    expect(LeagueResponse.parse(await res.json()).league).toMatchObject(settings);
    expect(await getLeague(l)).toMatchObject(settings);
  });

  it('changes only the setting named in the patch', async () => {
    const l = await league();

    await patchSettings(l, l.commissioner, { exhibitionCorrectionWindowDays: 0 });

    expect(await getLeague(l)).toMatchObject({
      ...DEFAULT_SETTINGS,
      exhibitionCorrectionWindowDays: 0,
    });
  });

  it('leaves the rules alone when the settings change', async () => {
    const l = await league();

    await patchSettings(l, l.commissioner, { confirmationWindowDays: 3 });

    expect((await getLeague(l)).rules).toEqual(DEFAULT_RULES);
  });

  it.each([
    ['the shortest', { confirmationWindowDays: 1, exhibitionCorrectionWindowDays: 0 }],
    ['the longest', { confirmationWindowDays: 30, exhibitionCorrectionWindowDays: 365 }],
  ])('accepts %s windows allowed', async (_label, settings) => {
    const l = await league();

    const res = await patchSettings(l, l.commissioner, settings);

    expect(res.status).toBe(200);
    expect(await getLeague(l)).toMatchObject(settings);
  });

  it('records the change in the audit log with the settings before and after', async () => {
    const l = await league();
    clock.advance(5 * SECOND);

    await patchSettings(l, l.commissioner, { confirmationWindowDays: 3 });

    const { events } = await auditLog(l);
    expect(events).toEqual([
      {
        id: expect.any(String),
        createdAt: '2026-10-18T12:00:05.000Z',
        actor: { membershipId: l.commissionerMembershipId, displayName: 'Ana' },
        actorWasParticipant: false,
        action: 'league.settings_updated',
        targetType: 'league',
        targetId: l.leagueId,
        details: {
          before: DEFAULT_SETTINGS,
          after: { ...DEFAULT_SETTINGS, confirmationWindowDays: 3 },
        },
      },
    ]);
  });

  it('writes no audit entry for a patch that changes nothing', async () => {
    const l = await league();

    const res = await patchSettings(l, l.commissioner, { confirmationWindowDays: 7 });

    expect(res.status).toBe(200);
    expect((await auditLog(l)).events).toEqual([]);
  });

  it('refuses a member who is not a commissioner, leaving the settings and the log untouched', async () => {
    const l = await league();
    const bo = await member(l, 'bo@example.com', 'Bo');

    const res = await patchSettings(l, bo.caller, { confirmationWindowDays: 3 });

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
    expect(await getLeague(l)).toMatchObject(DEFAULT_SETTINGS);
    expect((await auditLog(l)).events).toEqual([]);
  });

  it.each([
    ['an empty patch', {}],
    ['a confirmation window of 0 days', { confirmationWindowDays: 0 }],
    ['a confirmation window of 31 days', { confirmationWindowDays: 31 }],
    ['a correction window of 366 days', { exhibitionCorrectionWindowDays: 366 }],
    ['a rule', { targetScore: 21 }],
    ['an unknown field', { confirmationWindowDays: 3, name: 'Garage League' }],
  ])('rejects %s with 422 VALIDATION and changes nothing', async (_label, body) => {
    const l = await league();

    const res = await patchSettings(l, l.commissioner, body);

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
    expect(await getLeague(l)).toMatchObject(DEFAULT_SETTINGS);
  });
});

describe('audit log', () => {
  it('is visible to a member who is not a commissioner', async () => {
    const l = await league();
    const bo = await member(l, 'bo@example.com', 'Bo');
    await patchRules(l, l.commissioner, { targetScore: 21 });

    const { events } = await auditLog(l, bo.caller);

    expect(events.map((e) => e.action)).toEqual(['league.rules_updated']);
  });

  it('lists the newest entry first', async () => {
    const l = await league();
    await patchRules(l, l.commissioner, { targetScore: 21 });
    await patchSettings(l, l.commissioner, { confirmationWindowDays: 3 });

    const { events } = await auditLog(l);

    expect(events.map((e) => e.action)).toEqual([
      'league.settings_updated',
      'league.rules_updated',
    ]);
  });

  it('pages through the log with limit and before', async () => {
    const l = await league();
    for (const targetScore of [15, 21, 7]) {
      await patchRules(l, l.commissioner, { targetScore });
    }

    const first = await auditLog(l, l.commissioner, 'limit=2');
    const second = await auditLog(l, l.commissioner, `limit=2&before=${first.nextBefore}`);

    expect(targetScoresAfter(first.events)).toEqual([7, 21]);
    expect(first.nextBefore).toBe(first.events[1]!.id);
    expect(targetScoresAfter(second.events)).toEqual([15]);
    expect(second.nextBefore).toBeNull();
  });

  it('returns 50 entries per page by default', async () => {
    const l = await league();
    for (let i = 0; i < 51; i++) {
      await patchRules(l, l.commissioner, { targetScore: 12 + (i % 2) });
    }

    const first = await auditLog(l);
    const second = await auditLog(l, l.commissioner, `before=${first.nextBefore}`);

    expect(first.events).toHaveLength(50);
    expect(second.events).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
  });

  it('reports no next page when the last page is exactly full', async () => {
    const l = await league();
    for (const targetScore of [15, 21]) {
      await patchRules(l, l.commissioner, { targetScore });
    }

    const page = await auditLog(l, l.commissioner, 'limit=2');

    expect(page.events).toHaveLength(2);
    expect(page.nextBefore).toBeNull();
  });

  it.each(['limit=0', 'limit=101', 'limit=ten', 'before=yesterday', 'action=league.rules_updated'])(
    'rejects the query %j with 422 VALIDATION',
    async (query) => {
      const l = await league();

      const res = await call('GET', `/api/leagues/${l.leagueId}/audit?${query}`, {
        as: l.commissioner,
      });

      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe('VALIDATION');
    },
  );

  it("never lists another league's entries, even with that league's cursor", async () => {
    const x = await league();
    const y = await league('Garage League', 'yan@example.com');
    await patchRules(y, y.commissioner, { targetScore: 21 });
    await patchRules(y, y.commissioner, { targetScore: 15 });
    const [newest] = (await auditLog(y)).events;

    const page = await auditLog(x, x.commissioner, `before=${newest!.id}`);

    expect(page.events).toEqual([]);
    expect((await auditLog(x)).events).toEqual([]);
  });

  // The app's role will also lack the UPDATE, DELETE, and TRUNCATE grants (SPEC §4); the
  // triggers hold even for the database owner, which is what dev and tests connect as.
  it.each([
    ['an update of the log', sql`update audit_events set action = 'league.settings_updated'`],
    ['a delete from the log', sql`delete from audit_events`],
    ['a truncate of the log', sql`truncate audit_events`],
    ['a truncate of leagues that cascades to the log', sql`truncate leagues cascade`],
  ])('refuses %s, even for the database owner', async (_label, statement) => {
    const l = await league();
    await patchRules(l, l.commissioner, { targetScore: 21 });

    const attempt = api.db.execute(statement);

    await expect(attempt).rejects.toMatchObject({
      cause: { message: 'audit_events is append-only' },
    });
    expect((await auditLog(l)).events.map((e) => e.action)).toEqual(['league.rules_updated']);
  });
});
