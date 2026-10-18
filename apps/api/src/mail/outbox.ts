import { and, asc, eq, isNull, lt, lte } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import { deriveKey } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { emailOutbox, users } from '../db/schema.ts';
import { type Log, safeErrorFields } from '../log.ts';
import { renderEmail, SENSITIVE_TEMPLATES } from './templates.ts';

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
// retried once the backoff passes. Mail is sent outside any transaction.
export async function drainOutbox(
  deps: DrainDeps,
): Promise<{ sent: number; failed: number; dropped: number }> {
  const { db, clock, transport, log } = deps;
  const now = clock.now();
  const key = outboxKey(deps.authSecret);
  const result = { sent: 0, failed: 0, dropped: 0 };

  const claimed = await db.transaction(async (tx) => {
    const due = await tx
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
          lt(emailOutbox.attempts, MAX_SEND_ATTEMPTS),
          lte(emailOutbox.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(emailOutbox.nextAttemptAt))
      .limit(BATCH_SIZE)
      .for('update', { of: emailOutbox, skipLocked: true });
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
    const wipe = SENSITIVE_TEMPLATES.has(row.template) ? { params: {} } : {};
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
