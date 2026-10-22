import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateUser } from '../src/auth/otp.ts';
import { createSession } from '../src/auth/sessions.ts';
import { FixedClock } from '../src/clock.ts';
import { authCodes, emailOutbox, rateLimits, sessions, users } from '../src/db/schema.ts';
import { purgeStale } from '../src/domain/purge.ts';
import { drainOutbox, enqueueEmail, type MailTransport } from '../src/mail/outbox.ts';
import { MEMBER_PENDING, memberPendingParams } from '../src/mail/templates.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { createLeague, signIn } from './support/league.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;

const delivered: MailTransport = { sendMail: async () => ({}) };
const refused: MailTransport = {
  sendMail: async () => {
    throw Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
  },
};

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  clock = new FixedClock('2026-10-17T12:00:00.000Z');
  api = await startApi(database.url, { clock });
  await resetTables(api.db);
});

afterEach(async () => {
  await api.stop();
});

const purge = (opts?: { batchSize?: number; maxBatches?: number }) =>
  purgeStale({ db: api.db, clock }, opts);

async function requestCode(email: string): Promise<void> {
  const res = await fetch(`${api.baseUrl}/api/auth/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(202);
}

async function drain(transport: MailTransport): Promise<void> {
  await drainOutbox({
    db: api.db,
    clock,
    transport,
    mailFrom: 'League <league@example.com>',
    authSecret: api.authSecret,
    log: () => {},
  });
}

const userEmails = async () =>
  (await api.db.select({ email: users.email }).from(users).orderBy(asc(users.email))).map(
    (u) => u.email,
  );

const sessionUsers = async () =>
  (await api.db.select({ userId: sessions.userId }).from(sessions)).map((s) => s.userId);

describe('sessions', () => {
  it('deletes a session once its idle expiry has passed and keeps a live one', async () => {
    const stale = await signIn(api.db, clock, 'stale@example.com');
    clock.advance(15 * DAY);
    const live = await signIn(api.db, clock, 'live@example.com');
    clock.advance(15 * DAY - SECOND);

    await purge();
    expect(await sessionUsers()).toEqual([stale.userId, live.userId]);

    clock.advance(SECOND);
    await purge();
    expect(await sessionUsers()).toEqual([live.userId]);
  });
});

describe('sign-in codes', () => {
  it('deletes a code, and the email it holds, once the code expires', async () => {
    await requestCode('ana@example.com');
    clock.advance(10 * MINUTE - SECOND);
    await purge();
    expect(await api.db.select().from(authCodes)).toHaveLength(1);

    clock.advance(SECOND);
    await purge();
    expect(await api.db.select().from(authCodes)).toEqual([]);
  });
});

describe('rate limits', () => {
  it('deletes a window once it is a day old, the longest any limit uses', async () => {
    await requestCode('ana@example.com');
    expect(await api.db.select().from(rateLimits)).toHaveLength(2);

    clock.advance(DAY - SECOND);
    await purge();
    expect(await api.db.select().from(rateLimits)).toHaveLength(2);

    clock.advance(SECOND);
    await purge();
    expect(await api.db.select().from(rateLimits)).toEqual([]);
  });
});

describe('mail', () => {
  async function mailFor(email: string): Promise<string> {
    await createLeague(api.db, clock, { name: 'Basement', email, displayName: 'Commish' });
    const [row] = await api.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await api.db.transaction((tx) =>
      enqueueEmail(tx, {
        userId: row!.id,
        template: MEMBER_PENDING,
        params: memberPendingParams('Newcomer', 'https://app.test/members'),
        now: clock.now(),
      }),
    );
    return row!.id;
  }

  const outboxUsers = async () =>
    (await api.db.select({ userId: emailOutbox.userId }).from(emailOutbox)).map((r) => r.userId);

  it('deletes delivered mail seven days after it was queued', async () => {
    const userId = await mailFor('ana@example.com');
    await drain(delivered);

    clock.advance(7 * DAY - SECOND);
    await purge();
    expect(await outboxUsers()).toEqual([userId]);

    clock.advance(SECOND);
    await purge();
    expect(await outboxUsers()).toEqual([]);
  });

  it('deletes mail that failed for good seven days after it was queued', async () => {
    await mailFor('ana@example.com');
    for (let attempt = 0; attempt < 5; attempt++) {
      await drain(refused);
      clock.advance(10 * MINUTE);
    }
    const [row] = await api.db.select().from(emailOutbox);
    expect(row).toMatchObject({ attempts: 5, sentAt: null });

    clock.advance(7 * DAY);
    await purge();
    expect(await outboxUsers()).toEqual([]);
  });

  it('keeps mail that is still waiting to be sent, however old', async () => {
    const userId = await mailFor('ana@example.com');
    await drain(refused);

    clock.advance(30 * DAY);
    await purge();
    expect(await outboxUsers()).toEqual([userId]);
  });
});

describe('users', () => {
  it('deletes a user who never joined a league a day after they asked for a code', async () => {
    await requestCode('stranger@example.com');
    await drain(delivered);

    clock.advance(DAY - SECOND);
    await purge();
    expect(await userEmails()).toEqual(['stranger@example.com']);

    clock.advance(SECOND);
    await purge();
    expect(await userEmails()).toEqual([]);
    expect(await api.db.select().from(emailOutbox)).toEqual([]);
  });

  it('keeps a league member who has never signed in', async () => {
    await createLeague(api.db, clock, {
      name: 'Basement',
      email: 'commish@example.com',
      displayName: 'Commish',
    });
    clock.advance(30 * DAY);
    await purge();
    expect(await userEmails()).toEqual(['commish@example.com']);
  });

  it('keeps a user with a live session, and deletes them once it expires', async () => {
    await signIn(api.db, clock, 'lurker@example.com');
    clock.advance(30 * DAY - SECOND);
    await purge();
    expect(await userEmails()).toEqual(['lurker@example.com']);

    clock.advance(SECOND);
    await purge();
    expect(await userEmails()).toEqual([]);
  });

  it('keeps a user with a live sign-in code', async () => {
    await requestCode('returning@example.com');
    await drain(delivered);
    clock.advance(2 * DAY);
    await requestCode('returning@example.com');
    await drain(delivered);

    await purge();
    expect(await userEmails()).toEqual(['returning@example.com']);
  });

  it('keeps a user with mail still waiting to be sent', async () => {
    await requestCode('unlucky@example.com');
    await drain(refused);
    clock.advance(DAY + SECOND);

    await purge();
    expect(await userEmails()).toEqual(['unlucky@example.com']);
  });

  it('skips a user whose sign-in is in flight, which then completes', async () => {
    await requestCode('racer@example.com');
    await drain(delivered);
    clock.advance(2 * DAY);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const signingIn = api.db.transaction(async (tx) => {
      const userId = await findOrCreateUser(tx, 'racer@example.com', clock.now());
      locked();
      await held;
      await createSession(tx, { userId, client: 'web', now: clock.now() });
      return userId;
    });
    await lockTaken;

    await purge();
    release();
    const userId = await signingIn;

    expect(await userEmails()).toEqual(['racer@example.com']);
    expect(await sessionUsers()).toEqual([userId]);
  });

  it('lets a purged email sign in again as a new, unlinked user', async () => {
    const first = await signIn(api.db, clock, 'again@example.com');
    clock.advance(31 * DAY);
    await purge();

    const second = await signIn(api.db, clock, 'again@example.com');
    expect(second.userId).not.toBe(first.userId);
  });
});

describe('batching', () => {
  it('stops after the batch budget and reports that more remains', async () => {
    await signIn(api.db, clock, 'a@example.com');
    await signIn(api.db, clock, 'b@example.com');
    clock.advance(30 * DAY);

    expect(await purge({ batchSize: 1, maxBatches: 1 })).toMatchObject({ done: false });
    expect(await sessionUsers()).toHaveLength(1);
    expect(await purge({ batchSize: 1, maxBatches: 2 })).toMatchObject({ done: true });
    expect(await sessionUsers()).toEqual([]);
  });

  it('reports what it deleted', async () => {
    await requestCode('stranger@example.com');
    await drain(delivered);
    await signIn(api.db, clock, 'lurker@example.com');
    clock.advance(31 * DAY);

    expect(await purge()).toEqual({
      purged: { sessions: 1, codes: 1, rateLimits: 2, mail: 1, users: 2 },
      done: true,
    });
  });
});
