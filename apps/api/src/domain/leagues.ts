import { type League, nameKey } from '@beer-die/core';
import { and, eq } from 'drizzle-orm';
import { findOrCreateUser } from '../auth/otp.ts';
import type { Db } from '../db/client.ts';
import { leagues, memberships, users } from '../db/schema.ts';

// Bootstrap only (the CLI): a league plus its first commissioner, approved. The commissioner
// signs in later with the same email. Inputs are already parsed with the core schemas.
export async function createLeague(
  db: Db,
  input: { name: string; commissionerEmail: string; displayName: string; now: Date },
): Promise<{ leagueId: string; membershipId: string }> {
  return db.transaction(async (tx) => {
    const userId = await findOrCreateUser(tx, input.commissionerEmail, input.now);
    const [league] = await tx
      .insert(leagues)
      .values({ name: input.name, createdAt: input.now })
      .returning({ id: leagues.id });
    if (!league) throw new Error('insert returned no league');
    const [membership] = await tx
      .insert(memberships)
      .values({
        leagueId: league.id,
        userId,
        displayName: input.displayName,
        nameKey: nameKey(input.displayName),
        role: 'commissioner',
        status: 'approved',
        createdAt: input.now,
      })
      .returning({ id: memberships.id });
    if (!membership) throw new Error('insert returned no membership');
    return { leagueId: league.id, membershipId: membership.id };
  });
}

// Bootstrap only (the CLI): recovers a league whose commissioners are gone. Returns the
// promoted membership's id, or null when the email has no approved membership there.
export async function promoteCommissioner(
  db: Db,
  input: { leagueId: string; email: string },
): Promise<string | null> {
  const [row] = await db
    .update(memberships)
    .set({ role: 'commissioner' })
    .from(users)
    .where(
      and(
        eq(memberships.leagueId, input.leagueId),
        eq(memberships.status, 'approved'),
        eq(users.id, memberships.userId),
        eq(users.email, input.email),
      ),
    )
    .returning({ id: memberships.id });
  return row?.id ?? null;
}

// `leagueId` always comes from the caller's resolved membership, so the row exists.
export async function getLeague(db: Db, leagueId: string): Promise<League> {
  const [row] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!row) throw new Error('league of a resolved membership is missing');
  return {
    id: row.id,
    name: row.name,
    rules: {
      targetScore: row.targetScore,
      winBy: row.winBy,
      sinkPoints: row.sinkPoints,
      sinkEndsGame: row.sinkEndsGame,
    },
    confirmationWindowDays: row.confirmationWindowDays,
    exhibitionCorrectionWindowDays: row.exhibitionCorrectionWindowDays,
  };
}
