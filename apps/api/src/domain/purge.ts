import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { RATE_LIMIT_MAX_WINDOW_MS } from '../auth/rateLimit.ts';
import type { Clock } from '../clock.ts';
import type { Db } from '../db/client.ts';
import { authCodes, emailOutbox, memberships, rateLimits, sessions, users } from '../db/schema.ts';
import { MAX_SEND_ATTEMPTS } from '../mail/outbox.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Delivered or abandoned mail is kept this long, to diagnose delivery, then deleted.
export const FINISHED_MAIL_RETENTION_MS = 7 * DAY_MS;
// A user row is created as soon as anyone asks for a code for an email. One that has never
// joined a league, and holds no session, live code, or pending mail, is deleted this long
// after it was created, so typed-in emails don't accumulate.
export const UNJOINED_USER_GRACE_MS = DAY_MS;

const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 10;

type Deps = { db: Db; clock: Clock };
type Batch = { scanned: number; purged: Partial<PurgeCounts> };
export type PurgeCounts = {
  sessions: number;
  codes: number;
  rateLimits: number;
  mail: number;
  users: number;
};

// The worker's housekeeping: deletes rows that no longer do anything. Each kind runs in
// batches of `batchSize`, at most `maxBatches` per kind per call, so a backlog can't hold up
// the rest of the worker; `done` is false when more may remain. Rows a write holds locked are
// skipped. Correctness never depends on this running: every read already ignores these rows.
export async function purgeStale(
  deps: Deps,
  {
    batchSize = PURGE_BATCH,
    maxBatches = PURGE_MAX_BATCHES,
  }: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ purged: PurgeCounts; done: boolean }> {
  for (const [name, value] of [
    ['batchSize', batchSize],
    ['maxBatches', maxBatches],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  const now = deps.clock.now();
  const purged: PurgeCounts = { sessions: 0, codes: 0, rateLimits: 0, mail: 0, users: 0 };
  let done = true;
  // Users go last: they become eligible once their sessions, codes, and mail are gone.
  for (const step of [
    expiredSessions,
    expiredCodes,
    staleRateLimits,
    finishedMail,
    unjoinedUsers,
  ]) {
    let drained = false;
    for (let i = 0; i < maxBatches && !drained; i++) {
      const batch = await step(deps.db, now, batchSize);
      for (const [kind, n] of Object.entries(batch.purged) as Array<[keyof PurgeCounts, number]>) {
        purged[kind] += n;
      }
      drained = batch.scanned < batchSize;
    }
    if (!drained) done = false;
  }
  return { purged, done };
}

// A session is dead once its idle expiry passes; resolveSession already refuses it.
async function expiredSessions(db: Db, now: Date, limit: number): Promise<Batch> {
  const due = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lte(sessions.expiresAt, now))
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .delete(sessions)
    .where(inArray(sessions.id, due))
    .returning({ id: sessions.id });
  return { scanned: rows.length, purged: { sessions: rows.length } };
}

// A code is dead once it expires (and sooner if used or exhausted). Its row holds the email
// in the clear, so it goes as soon as it can no longer be used.
async function expiredCodes(db: Db, now: Date, limit: number): Promise<Batch> {
  const due = db
    .select({ id: authCodes.id })
    .from(authCodes)
    .where(lte(authCodes.expiresAt, now))
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .delete(authCodes)
    .where(inArray(authCodes.id, due))
    .returning({ id: authCodes.id });
  return { scanned: rows.length, purged: { codes: rows.length } };
}

// A window older than the longest any limit uses restarts on its next hit, so a missing row
// behaves exactly like it.
async function staleRateLimits(db: Db, now: Date, limit: number): Promise<Batch> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_MAX_WINDOW_MS);
  const due = db
    .select({ key: rateLimits.key })
    .from(rateLimits)
    .where(lte(rateLimits.windowStart, cutoff))
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .delete(rateLimits)
    .where(inArray(rateLimits.key, due))
    .returning({ key: rateLimits.key });
  return { scanned: rows.length, purged: { rateLimits: rows.length } };
}

// Mail the worker will never touch again: sent, or out of attempts.
const finished = or(
  isNotNull(emailOutbox.sentAt),
  sql`${emailOutbox.attempts} >= ${MAX_SEND_ATTEMPTS}`,
);

async function finishedMail(db: Db, now: Date, limit: number): Promise<Batch> {
  const cutoff = new Date(now.getTime() - FINISHED_MAIL_RETENTION_MS);
  const due = db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(finished, lte(emailOutbox.createdAt, cutoff)))
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .delete(emailOutbox)
    .where(inArray(emailOutbox.id, due))
    .returning({ id: emailOutbox.id });
  return { scanned: rows.length, purged: { mail: rows.length } };
}

async function unjoinedUsers(db: Db, now: Date, limit: number): Promise<Batch> {
  const cutoff = new Date(now.getTime() - UNJOINED_USER_GRACE_MS);
  return db.transaction(async (tx) => {
    const unused = and(
      notExists(
        tx
          .select({ one: sql`1` })
          .from(memberships)
          .where(eq(memberships.userId, users.id)),
      ),
      notExists(
        tx
          .select({ one: sql`1` })
          .from(sessions)
          .where(eq(sessions.userId, users.id)),
      ),
      notExists(
        tx
          .select({ one: sql`1` })
          .from(authCodes)
          .where(and(sql`${authCodes.email} = ${users.email}`, gt(authCodes.expiresAt, now))),
      ),
      notExists(
        tx
          .select({ one: sql`1` })
          .from(emailOutbox)
          .where(
            and(
              eq(emailOutbox.userId, users.id),
              isNull(emailOutbox.sentAt),
              lt(emailOutbox.attempts, MAX_SEND_ATTEMPTS),
            ),
          ),
      ),
    );
    // Every write that adds a session, membership, or mail for an existing user first locks
    // its row (findOrCreateUser's upsert, or FOR SHARE), so SKIP LOCKED passes over any user
    // with such a write in flight.
    const locked = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(lte(users.createdAt, cutoff), unused))
      .orderBy(asc(users.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (locked.length === 0) return { scanned: 0, purged: {} };
    // Checked again with a fresh snapshot: a write that committed after the first one, but
    // before the lock was taken, is visible now. Nothing new can reference a locked row.
    const ids = (
      await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(
              users.id,
              locked.map((u) => u.id),
            ),
            unused,
          ),
        )
    ).map((u) => u.id);
    if (ids.length === 0) return { scanned: locked.length, purged: {} };
    const mail = await tx
      .delete(emailOutbox)
      .where(inArray(emailOutbox.userId, ids))
      .returning({ id: emailOutbox.id });
    const gone = await tx.delete(users).where(inArray(users.id, ids)).returning({ id: users.id });
    return { scanned: locked.length, purged: { users: gone.length, mail: mail.length } };
  });
}
