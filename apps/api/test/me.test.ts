import { randomUUID } from 'node:crypto';
import {
  CreateInviteResponse,
  ErrorBody,
  JoinResponse,
  MembersResponse,
  MeResponse,
} from '@beer-die/core';
import { eq, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { memberships } from '../src/db/schema.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { type Caller, client, createLeague, deletionCode, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

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
  await resetTables(api.db);
});

afterEach(async () => {
  await api.stop();
});

type League = { leagueId: string; commissioner: Caller };
type Player = { caller: Caller; membershipId: string };

async function league(name: string, email: string, displayName: string): Promise<League> {
  const { leagueId } = await createLeague(api.db, clock, { name, email, displayName });
  return { leagueId, commissioner: await signIn(api.db, clock, email) };
}

async function joined(l: League, caller: Caller, displayName: string): Promise<string> {
  const created = await call('POST', `/api/leagues/${l.leagueId}/invites`, {
    as: l.commissioner,
    body: {},
  });
  const { url } = CreateInviteResponse.parse(await created.json());
  const token = url.slice(`${APP_ORIGIN}/join/`.length);
  const res = await call('POST', `/api/invites/${token}/join`, {
    as: caller,
    body: { displayName },
  });
  expect(res.status).toBe(201);
  return JoinResponse.parse(await res.json()).membership.id;
}

async function member(l: League, email: string, displayName: string): Promise<Player> {
  const caller = await signIn(api.db, clock, email);
  const membershipId = await joined(l, caller, displayName);
  const res = await call('POST', `/api/leagues/${l.leagueId}/members/${membershipId}/approve`, {
    as: l.commissioner,
    body: {},
  });
  expect(res.status).toBe(200);
  return { caller, membershipId };
}

function patchMe(as: Caller | undefined, body: unknown): Promise<Response> {
  return call('PATCH', '/api/me', { as, body });
}

async function me(as: Caller): Promise<MeResponse> {
  const res = await call('GET', '/api/me', { as });
  expect(res.status).toBe(200);
  return MeResponse.parse(await res.json());
}

function drain() {
  return drainOutbox({
    db: api.db,
    clock,
    transport: capturingTransport,
    mailFrom: 'Beer Die League <league@app.test>',
    authSecret: api.authSecret,
    log: () => {},
  });
}

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

async function names(l: League): Promise<string[]> {
  const res = await call('GET', `/api/leagues/${l.leagueId}/members`, { as: l.commissioner });
  expect(res.status).toBe(200);
  return MembersResponse.parse(await res.json())
    .members.map((m) => m.displayName)
    .sort();
}

// Ana is the commissioner of the Basement; Bo and Cy are members.
async function basement() {
  const l = await league('Basement', 'ana@example.com', 'Ana');
  return {
    ...l,
    bo: await member(l, 'bo@example.com', 'Bo'),
    cy: await member(l, 'cy@example.com', 'Cy'),
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NAME_HOLD = 90 * DAY;

function rename(p: Player, displayName: string): Promise<Response> {
  return patchMe(p.caller, { displayName });
}

async function renamed(p: Player, displayName: string): Promise<void> {
  expect((await rename(p, displayName)).status).toBe(200);
}

// Moves the clock on by `ms`. Sessions don't last that long, so a player who acts afterwards
// signs in again first (`again`).
function later(ms: number): void {
  clock.advance(ms);
}

async function again(p: Player, email: string): Promise<Player> {
  return { ...p, caller: await signIn(api.db, clock, email) };
}

// The names held for a member: the ones they gave up, as stored.
async function heldBy(p: Player): Promise<string[]> {
  const rows = await api.db.execute<{ name_key: string }>(
    sql`select name_key from released_names where membership_id = ${p.membershipId}
        order by name_key`,
  );
  return rows.map((r) => r.name_key);
}

describe('GET /api/me', () => {
  it('lists each membership with its email-notification setting, on by default', async () => {
    const t = await basement();

    expect((await me(t.bo.caller)).memberships).toEqual([
      expect.objectContaining({ displayName: 'Bo', emailNotifications: true }),
    ]);
  });
});

describe('PATCH /api/me', () => {
  it('renames the caller, and members see the new name', async () => {
    const t = await basement();

    const res = await patchMe(t.bo.caller, { displayName: '  Bobby  ' });

    expect(res.status).toBe(200);
    const body = MeResponse.parse(await res.json());
    expect(body.memberships).toEqual([
      expect.objectContaining({ id: t.bo.membershipId, displayName: 'Bobby' }),
    ]);
    expect(await names(t)).toEqual(['Ana', 'Bobby', 'Cy']);
  });

  it('turns email notifications off, so a new game no longer mails them', async () => {
    const t = await basement();
    const di = await member(t, 'di@example.com', 'Di');

    await drain();
    sent = [];
    const res = await patchMe(t.bo.caller, { emailNotifications: false });
    expect(res.status).toBe(200);
    expect((await me(t.bo.caller)).memberships[0]).toMatchObject({
      displayName: 'Bo',
      emailNotifications: false,
    });

    const submitted = await call('POST', `/api/leagues/${t.leagueId}/games`, {
      as: t.commissioner,
      body: {
        idempotencyKey: randomUUID(),
        kind: 'exhibition',
        playedAt: '2026-10-18T11:30:00.000Z',
        sides: {
          A: {
            players: [
              { membershipId: (await me(t.commissioner)).memberships[0]!.id, points: 6, sinks: 0 },
              { membershipId: t.bo.membershipId, points: 5, sinks: 0 },
            ],
          },
          B: {
            players: [
              { membershipId: t.cy.membershipId, points: 5, sinks: 0 },
              { membershipId: di.membershipId, points: 4, sinks: 0 },
            ],
          },
        },
        winner: 'A',
      },
    });
    expect(submitted.status).toBe(201);
    await drain();

    expect(sent.map((m) => m.to[0]!.address).sort()).toEqual(['cy@example.com', 'di@example.com']);
  });

  it('turns email notifications back on', async () => {
    const t = await basement();
    await patchMe(t.bo.caller, { emailNotifications: false });

    const res = await patchMe(t.bo.caller, { emailNotifications: true });

    expect(res.status).toBe(200);
    expect((await me(t.bo.caller)).memberships[0]!.emailNotifications).toBe(true);
  });

  it('lets the caller change the case of their own name', async () => {
    const t = await basement();

    const res = await patchMe(t.bo.caller, { displayName: 'BO' });

    expect(res.status).toBe(200);
    expect(await names(t)).toEqual(['Ana', 'BO', 'Cy']);
  });

  it.each([
    ['the same name', 'Cy'],
    ['the name in another case', 'cY'],
    ['a compatibility form of the name', 'Ｃｙ'],
  ])('refuses %s as another member holds, with 409, changing nothing', async (_label, name) => {
    const t = await basement();

    const res = await patchMe(t.bo.caller, { displayName: name, emailNotifications: false });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
    expect((await me(t.bo.caller)).memberships[0]).toMatchObject({
      displayName: 'Bo',
      emailNotifications: true,
    });
  });

  it("keeps a deleted member's kept name reserved", async () => {
    const t = await basement();
    const deleted = await call('DELETE', '/api/me', {
      as: t.cy.caller,
      body: { keepDisplayName: true, ...(await deletionCode(api, t.cy.caller)) },
    });
    expect(deleted.status).toBe(204);

    const res = await patchMe(t.bo.caller, { displayName: 'Cy' });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
  });

  it('renames a member still awaiting approval', async () => {
    const t = await basement();
    const di = await signIn(api.db, clock, 'di@example.com');
    await joined(t, di, 'Di');

    const res = await patchMe(di, { displayName: 'Dina' });

    expect(res.status).toBe(200);
    expect((await me(di)).memberships[0]).toMatchObject({ displayName: 'Dina', status: 'pending' });
  });

  it('renames the caller in every league they belong to', async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    await joined(attic, t.bo.caller, 'Bo');

    expect((await patchMe(t.bo.caller, { displayName: 'Bobby' })).status).toBe(200);

    expect((await me(t.bo.caller)).memberships.map((m) => m.displayName)).toEqual([
      'Bobby',
      'Bobby',
    ]);
  });

  it("refuses a name taken in any of the caller's leagues, changing none of them", async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    await joined(attic, t.bo.caller, 'Bo');

    const res = await patchMe(t.bo.caller, { displayName: 'Pat' });

    expect(res.status).toBe(409);
    expect((await me(t.bo.caller)).memberships.map((m) => m.displayName)).toEqual(['Bo', 'Bo']);
  });

  it('leaves a league the caller has left under the name they had', async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    const atticBo = await member(attic, 'bo@example.com', 'Bo');
    const left = await call('POST', `/api/leagues/${attic.leagueId}/leave`, {
      as: atticBo.caller,
      body: {},
    });
    expect(left.status).toBe(204);

    expect((await patchMe(t.bo.caller, { displayName: 'Bobby' })).status).toBe(200);

    const [row] = await api.db
      .select({ displayName: memberships.displayName, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, atticBo.membershipId));
    expect(row).toEqual({ displayName: 'Bo', status: 'left' });
  });

  it('gives one of two members racing for the same name the name, and the other 409', async () => {
    const t = await basement();

    const results = await Promise.all([
      patchMe(t.bo.caller, { displayName: 'Zed' }),
      patchMe(t.cy.caller, { displayName: 'Zed' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await names(t)).toContain('Zed');
  });

  // A refused name reveals that someone holds it, so name changes share the join budget:
  // together, ten an hour per user. Bo's join spent one.
  it('caps name changes, refused ones included, together with joins at ten an hour', async () => {
    const t = await basement();
    for (let i = 0; i < 9; i++) {
      expect((await patchMe(t.bo.caller, { displayName: 'Cy' })).status).toBe(409);
    }

    const res = await patchMe(t.bo.caller, { displayName: 'Bobby' });

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
    expect((await me(t.bo.caller)).memberships[0]!.displayName).toBe('Bo');
  });

  it('allows name changes again an hour later', async () => {
    const t = await basement();
    for (let i = 0; i < 10; i++) await patchMe(t.bo.caller, { displayName: 'Cy' });
    clock.advance(60 * 60 * 1000);

    expect((await patchMe(t.bo.caller, { displayName: 'Bobby' })).status).toBe(200);
  });

  it('never caps changes to the email setting, which reveal nothing', async () => {
    const t = await basement();
    for (let i = 0; i < 12; i++) {
      const res = await patchMe(t.bo.caller, { emailNotifications: i % 2 === 0 });
      expect(res.status).toBe(200);
    }
  });

  it.each([
    ['an empty body', {}],
    ['an unknown field', { displayName: 'Bobby', role: 'commissioner' }],
    ['a name that is too short', { displayName: 'B' }],
    ['a name with markup', { displayName: '<img src=x onerror=alert(1)>' }],
    ['a setting that is not a boolean', { emailNotifications: 'no' }],
  ])('refuses %s with 422 VALIDATION', async (_label, body) => {
    const t = await basement();

    const res = await patchMe(t.bo.caller, body);

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
  });

  it('needs a session', async () => {
    const res = await patchMe(undefined, { displayName: 'Bobby' });

    expect(res.status).toBe(401);
  });
});

// A member's old name stays theirs for 90 days after they rename, so nobody can step into a
// name the league still knows them by.
describe('a name a member gave up by renaming', () => {
  it('cannot be taken by another member', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');

    const res = await rename(t.cy, 'Bo');

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
    expect(await names(t)).toEqual(['Ana', 'Bobby', 'Cy']);
  });

  it('cannot be taken in another case or compatibility spelling', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');

    const res = await rename(t.cy, 'ＢＯ');

    expect(res.status).toBe(409);
  });

  it('cannot be taken by someone joining the league', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    const created = await call('POST', `/api/leagues/${t.leagueId}/invites`, {
      as: t.commissioner,
      body: {},
    });
    const { url } = CreateInviteResponse.parse(await created.json());
    const dee = await signIn(api.db, clock, 'dee@example.com');

    const res = await call('POST', `/api/invites/${url.slice(`${APP_ORIGIN}/join/`.length)}/join`, {
      as: dee,
      body: { displayName: 'Bo' },
    });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('NAME_TAKEN');
    expect((await me(dee)).memberships).toEqual([]);
  });

  it('can be taken back by the member who gave it up', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');

    const res = await rename(t.bo, 'Bo');

    expect(res.status).toBe(200);
    expect(await names(t)).toEqual(['Ana', 'Bo', 'Cy']);
  });

  it('stops being held once its owner takes it back, and the name they left is held instead', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');

    await renamed(t.bo, 'Bo');

    expect(await heldBy(t.bo)).toEqual(['bobby']);
  });

  it('is still held 1 s before 90 days have passed', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    later(NAME_HOLD - 1000);

    const res = await rename(await again(t.cy, 'cy@example.com'), 'Bo');

    expect(res.status).toBe(409);
  });

  it('is free for anyone 90 days after it was given up', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    later(NAME_HOLD);

    const res = await rename(await again(t.cy, 'cy@example.com'), 'Bo');

    expect(res.status).toBe(200);
    expect(
      await names({ ...t, commissioner: await signIn(api.db, clock, 'ana@example.com') }),
    ).toEqual(['Ana', 'Bo', 'Bobby']);
  });

  it('is held for 90 days from the last time it was given up, not the first', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    later(80 * DAY);
    const bo = await again(t.bo, 'bo@example.com');
    await renamed(bo, 'Bo');
    await renamed(bo, 'Bobby');
    later(20 * DAY);

    const res = await rename(await again(t.cy, 'cy@example.com'), 'Bo');

    expect(res.status).toBe(409);
  });

  it('passes to its new owner once free, who can then give it up in turn', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    later(NAME_HOLD);
    const cy = await again(t.cy, 'cy@example.com');
    await renamed(cy, 'Bo');

    await renamed(cy, 'Cyrus');

    expect(await heldBy(cy)).toEqual(['bo', 'cy']);
    expect((await rename(await again(t.bo, 'bo@example.com'), 'Bo')).status).toBe(409);
  });

  it('is not held when only its case changed', async () => {
    const t = await basement();

    await renamed(t.bo, 'BO');

    expect(await heldBy(t.bo)).toEqual([]);
  });

  it('is held in every league the member renamed in', async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    await member(attic, 'bo@example.com', 'Bo');
    const quin = await member(attic, 'quin@example.com', 'Quin');
    await renamed(t.bo, 'Bobby');

    const res = await rename(quin, 'Bo');

    expect(res.status).toBe(409);
  });

  it('is not held in a league the member does not belong to', async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    const quin = await member(attic, 'quin@example.com', 'Quin');
    await renamed(t.bo, 'Bobby');

    const res = await rename(quin, 'Bo');

    expect(res.status).toBe(200);
  });

  it('is not held when the member was still awaiting approval', async () => {
    const t = await basement();
    const dee: Player = {
      caller: await signIn(api.db, clock, 'dee@example.com'),
      membershipId: '',
    };
    dee.membershipId = await joined(t, dee.caller, 'Dee');
    await renamed(dee, 'Didi');

    const res = await rename(t.cy, 'Dee');

    expect(res.status).toBe(200);
  });

  it('stays held after the member leaves the league', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    const left = await call('POST', `/api/leagues/${t.leagueId}/leave`, {
      as: t.bo.caller,
      body: {},
    });
    expect(left.status).toBe(204);

    const res = await rename(t.cy, 'Bo');

    expect(res.status).toBe(409);
  });

  it('cannot be taken by a rename racing the one that gives it up', async () => {
    const t = await basement();

    const [giving, taking] = await Promise.all([rename(t.bo, 'Bobby'), rename(t.cy, 'Bo')]);

    expect([giving.status, taking.status]).toEqual([200, 409]);
    expect(await names(t)).toEqual(['Ana', 'Bobby', 'Cy']);
  });

  it('is refused whole when held in any of the caller’s leagues, changing none of them', async () => {
    const t = await basement();
    const attic = await league('Attic', 'pat@example.com', 'Pat');
    await member(attic, 'cy@example.com', 'Cy');
    await renamed(t.bo, 'Bobby');

    const res = await rename(t.cy, 'Bo');

    expect(res.status).toBe(409);
    expect((await me(t.cy.caller)).memberships.map((m) => m.displayName)).toEqual(['Cy', 'Cy']);
  });

  it('is erased when its owner deletes their account, which frees it', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bobby');
    const deleted = await call('DELETE', '/api/me', {
      as: t.bo.caller,
      body: { keepDisplayName: true, ...(await deletionCode(api, t.bo.caller)) },
    });
    expect(deleted.status).toBe(204);

    const res = await rename(t.cy, 'Bo');

    expect(await heldBy(t.bo)).toEqual([]);
    expect(res.status).toBe(200);
  });
});

describe('the names held for one member', () => {
  // Bo's join spent one of the ten name attempts an hour, so these stay within it.
  async function renamedThrough(p: Player, newNames: string[]): Promise<void> {
    for (const name of newNames) await renamed(p, name);
  }

  it('number at most five: a rename that would hold a sixth is refused', async () => {
    const t = await basement();
    await renamedThrough(t.bo, ['Bo1', 'Bo2', 'Bo3', 'Bo4', 'Bo5']);

    const res = await rename(t.bo, 'Bo6');

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('TOO_MANY_NAME_CHANGES');
    expect((await me(t.bo.caller)).memberships[0]!.displayName).toBe('Bo5');
    expect(await heldBy(t.bo)).toEqual(['bo', 'bo1', 'bo2', 'bo3', 'bo4']);
  });

  it('still let them go back to a name they hold when they hold five', async () => {
    const t = await basement();
    await renamedThrough(t.bo, ['Bo1', 'Bo2', 'Bo3', 'Bo4', 'Bo5']);

    const res = await rename(t.bo, 'Bo');

    expect(res.status).toBe(200);
  });

  it('make room for a new name once the oldest has been free for 90 days', async () => {
    const t = await basement();
    await renamed(t.bo, 'Bo1');
    later(DAY);
    await renamedThrough(t.bo, ['Bo2', 'Bo3', 'Bo4', 'Bo5']);
    later(NAME_HOLD - DAY);

    const res = await rename(await again(t.bo, 'bo@example.com'), 'Bo6');

    expect(res.status).toBe(200);
  });

  it('are counted per member', async () => {
    const t = await basement();
    await renamedThrough(t.bo, ['Bo1', 'Bo2', 'Bo3', 'Bo4', 'Bo5']);

    const res = await rename(t.cy, 'Cyrus');

    expect(res.status).toBe(200);
  });
});
