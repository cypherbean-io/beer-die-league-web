import type { SessionClient } from '@beer-die/core';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { sha256Hex } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// However much a session is used, it ends this long after sign-in, so a stolen token stops
// working even if its thief keeps it busy.
export const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;

// 32 random bytes, base64url: always 43 characters.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SessionAuth = {
  sessionId: string;
  userId: string;
  email: string;
  client: SessionClient;
};

// Returns the raw token for the caller to hand to the client; only its hash is stored.
export async function createSession(
  tx: Tx,
  input: { userId: string; client: SessionClient; now: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx.insert(sessions).values({
    userId: input.userId,
    tokenSha256: sha256Hex(token),
    client: input.client,
    createdAt: input.now,
    lastUsedAt: input.now,
    expiresAt: new Date(input.now.getTime() + SESSION_IDLE_MS),
  });
  return token;
}

// Resolves a live session for the token and slides its idle expiry, never past the session's
// absolute lifetime. `expires_at` therefore always holds the earlier of the two, which is all
// the purge needs to read. A token is accepted only over the transport its client uses: a
// cookie for web, a bearer header for native.
export async function resolveSession(
  db: Db,
  input: { token: string; client: SessionClient; now: Date },
): Promise<SessionAuth | null> {
  const idleExpiry = new Date(input.now.getTime() + SESSION_IDLE_MS).toISOString();
  const [row] = await db
    .update(sessions)
    .set({
      lastUsedAt: input.now,
      expiresAt: sql`least(${idleExpiry}::timestamptz, ${sessions.createdAt} + make_interval(secs => ${SESSION_MAX_MS / 1000}::float8))`,
    })
    .from(users)
    .where(
      and(
        eq(sessions.tokenSha256, sha256Hex(input.token)),
        eq(sessions.client, input.client),
        gt(sessions.expiresAt, input.now),
        // Also checked directly: a session from before the absolute lifetime existed can hold
        // an expiry beyond it.
        gt(sessions.createdAt, new Date(input.now.getTime() - SESSION_MAX_MS)),
        eq(users.id, sessions.userId),
        isNull(users.deletedAt),
        isNotNull(users.email),
      ),
    )
    .returning({ sessionId: sessions.id, userId: users.id, email: users.email });
  if (!row?.email) return null;
  return { sessionId: row.sessionId, userId: row.userId, email: row.email, client: input.client };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

// Signs the user out everywhere: every device and browser, the caller's included.
export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
