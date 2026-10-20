import { and, asc, eq, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import { deriveKey } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { emailOutbox, users } from '../db/schema.ts';
import { type Log, safeErrorFields } from '../log.ts';
import { renderEmail, SIGN_IN_CODE } from './templates.ts';

export type MailMessage = { from: string; to: string; subject: string; text: string };
export type MailTransport = { sendMail(message: MailMessage): Promise<unknown> };

export type DrainDeps = {
  db: Db;
  clock: Clock;
  transport: MailTransport;
  mailFrom: string;
  authSecret: string;
  log: Log;
};

export const MAX_SEND_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const BATCH_SIZE = 20;
// Codes fill a batch when no other mail is due, and otherwise keep at most this much of it,
// so other mail keeps moving even under a flood of sign-in requests.
const CODE_BATCH_SIZE = 15;

// Literals, not parameters, so the planner matches each claim to its partial index (see
// email_outbox in db/schema.ts) under a generic plan too.
const IS_CODE = sql`${emailOutbox.template} = ${sql.raw(`'${SIGN_IN_CODE}'`)}`;
const IS_NOT_CODE = sql`${emailOutbox.template} <> ${sql.raw(`'${SIGN_IN_CODE}'`)}`;
const BELOW_ATTEMPT_CAP = sql`${emailOutbox.attempts} < ${sql.raw(String(MAX_SEND_ATTEMPTS))}`;

// Key for sealing secrets inside outbox params; derived so AUTH_SECRET serves one purpose.
export function outboxKey(authSecret: string): Buffer {
  return deriveKey(authSecret, 'beer-die:outbox-params:v1');
}

// Called inside the request's transaction; the worker sends later, outside any request.
export async function enqueueEmail(
  tx: Tx,
  input: { userId: string; template: string; params: Record<string, unknown>; now: Date },
): Promise<void> {
  await tx.insert(emailOutbox).values({
    userId: input.userId,
    template: input.template,
    params: input.params,
    nextAttemptAt: input.now,
    createdAt: input.now,
  });
}

function providerErrorCode(err: unknown): string {
  const { code } = safeErrorFields(err);
  if (code) return code;
  const responseCode = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof responseCode === 'number' ? `SMTP_${responseCode}` : 'SEND_FAILED';
}

// Sends due rows. Claiming bumps `attempts` and pushes `next_attempt_at` out by the backoff
// (30 s, 1 m, 2 m, 4 m), which doubles as a lease: a row whose send crashed mid-way is
// retried once the backoff passes. Mail is sent outside any transaction. Sign-in codes are
// claimed first, because they expire in minutes and are the only way to sign in.
export async function drainOutbox(
  deps: DrainDeps,
): Promise<{ sent: number; failed: number; dropped: number }> {
  const { db, clock, transport, log } = deps;
  const now = clock.now();
  const key = outboxKey(deps.authSecret);
  const result = { sent: 0, failed: 0, dropped: 0 };

  const claimed = await db.transaction(async (tx) => {
    const claim = (kind: SQL, limit: number) =>
      tx
        .select({
          id: emailOutbox.id,
          template: emailOutbox.template,
          params: emailOutbox.params,
          attempts: emailOutbox.attempts,
          to: users.email,
        })
        .from(emailOutbox)
        .innerJoin(users, eq(users.id, emailOutbox.userId))
        .where(
          and(
            isNull(emailOutbox.sentAt),
            BELOW_ATTEMPT_CAP,
            kind,
            lte(emailOutbox.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(emailOutbox.nextAttemptAt))
        .limit(limit)
        .for('update', { of: emailOutbox, skipLocked: true });
    // Codes trimmed off to make room stay locked but untouched, so the next drain takes them.
    // A third claim to top up with codes would see this transaction's own locked rows again.
    const codes = await claim(IS_CODE, BATCH_SIZE);
    const others = await claim(IS_NOT_CODE, BATCH_SIZE - Math.min(codes.length, CODE_BATCH_SIZE));
    const due = [...codes.slice(0, BATCH_SIZE - others.length), ...others];
    for (const row of due) {
      row.attempts += 1;
      await tx
        .update(emailOutbox)
        .set({
          attempts: row.attempts,
          nextAttemptAt: new Date(now.getTime() + BASE_BACKOFF_MS * 2 ** (row.attempts - 1)),
        })
        .where(eq(emailOutbox.id, row.id));
    }
    return due;
  });

  for (const row of claimed) {
    // Params are needed only to render the mail. Once a row is terminal they are wiped, so
    // a sealed code or a display name doesn't outlive the message.
    const wipe = { params: {} };
    const rendered = row.to
      ? renderEmail(row.template, row.params, { key, now })
      : ({ drop: 'NO_RECIPIENT' } as const);
    const entry = {
      level: 'info',
      msg: 'outbox',
      outboxId: row.id,
      template: row.template,
    } as const;

    if ('drop' in rendered) {
      // Terminal: attempts at the cap means the row is never claimed again.
      await db
        .update(emailOutbox)
        .set({ attempts: MAX_SEND_ATTEMPTS, lastError: rendered.drop, ...wipe })
        .where(eq(emailOutbox.id, row.id));
      log({ ...entry, outcome: 'dropped', reason: rendered.drop });
      result.dropped += 1;
      continue;
    }

    try {
      await transport.sendMail({ from: deps.mailFrom, to: row.to!, ...rendered });
    } catch (err) {
      const terminal = row.attempts >= MAX_SEND_ATTEMPTS;
      const code = providerErrorCode(err);
      await db
        .update(emailOutbox)
        .set({ lastError: code, ...(terminal ? wipe : {}) })
        .where(eq(emailOutbox.id, row.id));
      log({ ...entry, level: 'warn', outcome: terminal ? 'failed' : 'retry', code });
      result.failed += 1;
      continue;
    }
    await db
      .update(emailOutbox)
      .set({ sentAt: now, lastError: null, ...wipe })
      .where(eq(emailOutbox.id, row.id));
    log({ ...entry, outcome: 'sent' });
    result.sent += 1;
  }
  return result;
}
