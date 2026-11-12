import {
  type SessionClient,
  SIGN_IN_CODE_ALPHABET,
  SIGN_IN_CODE_LENGTH,
  type User,
} from '@beer-die/core';
import { randomBytes, randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import { hexEqual, hmacHex, sha256Hex } from '../crypto.ts';
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
// The per-email cap bounds the mail one address can be sent, so it has to count requests from
// anyone. Someone else can therefore use it up, which holds off new codes for that address for
// up to an hour; a code already issued keeps working.
const CODE_REQUESTS_PER_HOUR = { ip: 20, email: 5 } as const;
// Bounds one client's reach. There is no cap per email: an attempt counts only against the
// code whose request token it carries, so a cap anyone could fill for someone else's address
// would only lock its owner out. Guessing is bounded instead by the code's length (2^40), its
// 5 attempts, and the request caps above.
const VERIFIES_PER_HOUR_PER_IP = 60;

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

function newCode(): string {
  return Array.from(
    { length: SIGN_IN_CODE_LENGTH },
    () => SIGN_IN_CODE_ALPHABET[randomInt(SIGN_IN_CODE_ALPHABET.length)],
  ).join('');
}

// Issues a code for `email`, queues it for mail, and returns the request token it works with.
// Earlier codes for the email are left alone, so a request by someone else can't invalidate
// the one its owner is about to enter. Neither the token nor anything else about the response
// depends on whether the email has an account.
export async function requestCode(
  deps: AuthDeps,
  input: { email: string; ip: string },
): Promise<string> {
  const { db, clock, config } = deps;
  const now = clock.now();
  for (const kind of ['ip', 'email'] as const) {
    const key = rateLimitKey(config.authSecret, kind, input[kind]);
    if (!(await hit(db, key, CODE_REQUESTS_PER_HOUR[kind], HOUR_MS, now))) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in requests. Try again later.');
    }
  }

  const code = newCode();
  const requestToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  // The code row, then the user row: verifyCode takes them in that order, so the two can't
  // deadlock on one email.
  await db.transaction(async (tx) => {
    await tx.insert(authCodes).values({
      email: input.email,
      requestTokenSha256: sha256Hex(requestToken),
      codeHmac: codeHmac(config.authSecret, input.email, code),
      createdAt: now,
      expiresAt,
    });
    const userId = await findOrCreateUser(tx, input.email, now);
    await enqueueEmail(tx, {
      userId,
      template: SIGN_IN_CODE,
      params: signInCodeParams(outboxKey(config.authSecret), code, expiresAt),
      now,
    });
  });
  return requestToken;
}

// Exchanges a code, and the token its request was answered with, for a new session. A code is
// looked up by that token alone, so an attempt without it reaches no code and counts against
// none. Wrong, expired, used, exhausted, and missing codes are indistinguishable to the caller,
// as is a token that isn't the code's own.
export async function verifyCode(
  deps: AuthDeps,
  input: { email: string; code: string; requestToken: string; client: SessionClient; ip: string },
): Promise<{ user: User; token: string }> {
  const { db, clock, config } = deps;
  const now = clock.now();
  // Counted outside the transaction, so a rejected attempt still counts.
  const key = rateLimitKey(config.authSecret, 'verify-ip', input.ip);
  if (!(await hit(db, key, VERIFIES_PER_HOUR_PER_IP, HOUR_MS, now))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
  }
  const candidate = codeHmac(config.authSecret, input.email, input.code);

  // The row lock serializes concurrent guesses, so every wrong attempt is counted.
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authCodes)
      .where(eq(authCodes.requestTokenSha256, sha256Hex(input.requestToken)))
      .for('update');
    if (!row || row.consumedAt || row.expiresAt <= now || row.attempts >= MAX_VERIFY_ATTEMPTS) {
      return null;
    }
    // The HMAC covers the email, so a code presented for another address fails here too.
    if (row.email !== input.email || !hexEqual(candidate, row.codeHmac)) {
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
