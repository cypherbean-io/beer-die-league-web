import type { SessionClient } from '@beer-die/core';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { sha256Hex } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

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

// Resolves a live session for the token and slides its idle expiry. A token is accepted
// only over the transport its client uses: a cookie for web, a bearer header for native.
export async function resolveSession(
  db: Db,
  input: { token: string; client: SessionClient; now: Date },
): Promise<SessionAuth | null> {
  const [row] = await db
    .update(sessions)
    .set({
      lastUsedAt: input.now,
      expiresAt: new Date(input.now.getTime() + SESSION_IDLE_MS),
    })
    .from(users)
    .where(
      and(
        eq(sessions.tokenSha256, sha256Hex(input.token)),
        eq(sessions.client, input.client),
        gt(sessions.expiresAt, input.now),
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
