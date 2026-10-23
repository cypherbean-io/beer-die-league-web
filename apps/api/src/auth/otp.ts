import type { SessionClient, User } from '@beer-die/core';
import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import { hexEqual, hmacHex } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { authCodes, users } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { enqueueEmail, outboxKey } from '../mail/outbox.ts';
import { SIGN_IN_CODE, signInCodeParams } from '../mail/templates.ts';
import { hit, rateLimitKey } from './rateLimit.ts';
import { createSession } from './sessions.ts';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_VERIFY_ATTEMPTS = 5;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CODE_REQUESTS_PER_HOUR = { ip: 20, email: 5 } as const;
// Each new code brings 5 fresh attempts, so verify needs its own caps: per email across all
// codes (bounding guesses on one account), and per IP (bounding one client's reach).
const VERIFY_LIMITS = [
  { kind: 'verify-ip', input: 'ip', limit: 60, windowMs: HOUR_MS },
  { kind: 'verify-email', input: 'email', limit: 20, windowMs: DAY_MS },
] as const;

type AuthDeps = { db: Db; clock: Clock; config: { authSecret: string } };

function codeHmac(secret: string, email: string, code: string): string {
  return hmacHex(secret, `sign-in-code:${email}\n${code}`);
}

// Find-or-create in one statement, so known and unknown emails do the same work (and fall in
// the same timing class). The no-op update makes RETURNING yield the existing row.
export async function findOrCreateUser(tx: Tx, email: string, now: Date): Promise<string> {
  const [user] = await tx
    .insert(users)
    .values({ email, createdAt: now })
    .onConflictDoUpdate({ target: users.email, set: { email: sql`excluded.email` } })
    .returning({ id: users.id });
  if (!user) throw new Error('upsert returned no row');
  return user.id;
}

// Issues a fresh code for `email` (invalidating any earlier one) and queues it for mail.
// The response never depends on whether the email has an account.
export async function requestCode(
  deps: AuthDeps,
  input: { email: string; ip: string },
): Promise<void> {
  const { db, clock, config } = deps;
  const now = clock.now();
  for (const kind of ['ip', 'email'] as const) {
    const key = rateLimitKey(config.authSecret, kind, input[kind]);
    if (!(await hit(db, key, CODE_REQUESTS_PER_HOUR[kind], HOUR_MS, now))) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in requests. Try again later.');
    }
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const fields = {
    codeHmac: codeHmac(config.authSecret, input.email, code),
    createdAt: now,
    expiresAt,
    attempts: 0,
    consumedAt: null,
  };
  // The code row, then the user row: verifyCode takes them in that order, so the two can't
  // deadlock on one email.
  await db.transaction(async (tx) => {
    await tx
      .insert(authCodes)
      .values({ email: input.email, ...fields })
      .onConflictDoUpdate({ target: authCodes.email, set: fields });
    const userId = await findOrCreateUser(tx, input.email, now);
    await enqueueEmail(tx, {
      userId,
      template: SIGN_IN_CODE,
      params: signInCodeParams(outboxKey(config.authSecret), code, expiresAt),
      now,
    });
  });
}

// Exchanges a code for a new session. Wrong, expired, used, exhausted, and missing codes
// are indistinguishable to the caller.
export async function verifyCode(
  deps: AuthDeps,
  input: { email: string; code: string; client: SessionClient; ip: string },
): Promise<{ user: User; token: string }> {
  const { db, clock, config } = deps;
  const now = clock.now();
  // Counted outside the transaction, so a rejected attempt still counts.
  for (const { kind, input: field, limit, windowMs } of VERIFY_LIMITS) {
    const key = rateLimitKey(config.authSecret, kind, input[field]);
    if (!(await hit(db, key, limit, windowMs, now))) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
    }
  }
  const candidate = codeHmac(config.authSecret, input.email, input.code);

  // The row lock serializes concurrent guesses, so every wrong attempt is counted.
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authCodes)
      .where(eq(authCodes.email, input.email))
      .for('update');
    if (!row || row.consumedAt || row.expiresAt <= now || row.attempts >= MAX_VERIFY_ATTEMPTS) {
      return null;
    }
    if (!hexEqual(candidate, row.codeHmac)) {
      // Returned rather than thrown, so the increment commits.
      await tx
        .update(authCodes)
        .set({ attempts: sql`${authCodes.attempts} + 1` })
        .where(eq(authCodes.id, row.id));
      return null;
    }
    await tx.update(authCodes).set({ consumedAt: now }).where(eq(authCodes.id, row.id));
    const userId = await findOrCreateUser(tx, input.email, now);
    const token = await createSession(tx, { userId, client: input.client, now });
    return { user: { id: userId, email: input.email }, token };
  });

  if (!outcome) throw new ApiError(401, 'INVALID_CODE', 'That code is wrong or has expired.');
  return outcome;
}
