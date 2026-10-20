import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { gameRevisions, games } from '../db/schema.ts';

type GameRow = typeof games.$inferSelect;

// Materializes a lapsed window on a game whose row the caller holds locked: the open revision
// expires, and so does a game that never counted; one that did keeps its confirmed revision.
// Any other game comes back unchanged. Reads don't wait for this, because they treat
// `now ≥ window_expires_at` as expired. Game writes reach it through settleExpired
// (domain/games.ts), and finalizing a season (domain/seasons.ts) through it directly.
export async function expireLapsed(tx: Tx, game: GameRow, now: Date): Promise<GameRow> {
  const { openRevisionId, windowExpiresAt } = game;
  if (!openRevisionId || !windowExpiresAt || now.getTime() < windowExpiresAt.getTime()) {
    return game;
  }
  await tx
    .update(gameRevisions)
    .set({ status: 'expired' })
    .where(and(eq(gameRevisions.id, openRevisionId), eq(gameRevisions.status, 'open')));
  const [settled] = await tx
    .update(games)
    .set({
      status: game.confirmedRevisionId === null ? 'expired' : game.status,
      openRevisionId: null,
      windowExpiresAt: null,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!settled) throw new Error('locked game is missing');
  return settled;
}
