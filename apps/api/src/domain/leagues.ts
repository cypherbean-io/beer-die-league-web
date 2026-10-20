import { type League, type LeagueSettings, nameKey, type Rules } from '@beer-die/core';
import { and, eq } from 'drizzle-orm';
import { findOrCreateUser } from '../auth/otp.ts';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { leagues, memberships, users } from '../db/schema.ts';
import { recordAudit } from './audit.ts';
import { type Actor, assertCommissioner } from './membership.ts';

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

type LeagueRow = typeof leagues.$inferSelect;

function rulesOf(row: LeagueRow): Rules {
  return {
    targetScore: row.targetScore,
    winBy: row.winBy,
    sinkPoints: row.sinkPoints,
    sinkEndsGame: row.sinkEndsGame,
  };
}

function settingsOf(row: LeagueRow): LeagueSettings {
  return {
    confirmationWindowDays: row.confirmationWindowDays,
    exhibitionCorrectionWindowDays: row.exhibitionCorrectionWindowDays,
  };
}

function toLeague(row: LeagueRow): League {
  return { id: row.id, name: row.name, rules: rulesOf(row), ...settingsOf(row) };
}

const missingLeague = () => new Error('league of a resolved membership is missing');

// `leagueId` always comes from the caller's resolved membership, so the row exists.
export async function getLeague(db: Db, leagueId: string): Promise<League> {
  const [row] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!row) throw missingLeague();
  return toLeague(row);
}

// Locks the league row, the lock setRole also takes, then re-reads the actor's role under
// it. So a commissioner demoted while the request waited can't edit, and concurrent edits
// each read the values the previous one wrote, which keeps every audit entry's "before"
// accurate. Season edits (domain/seasons.ts) take it too, which serializes season starts.
export async function lockForCommissionerEdit(tx: Tx, actor: Actor): Promise<LeagueRow> {
  const [row] = await tx.select().from(leagues).where(eq(leagues.id, actor.leagueId)).for('update');
  if (!row) throw missingLeague();
  const [self] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')));
  assertCommissioner({ ...actor, role: self?.role ?? 'member' });
  return row;
}

function changed<T extends object>(before: T, after: T): boolean {
  return (Object.keys(after) as Array<keyof T>).some((key) => after[key] !== before[key]);
}

type EditDeps = { db: Db; clock: Clock };

// New rules apply to games submitted from now on. Each game keeps the rules snapshot from
// its first submission, so nothing already submitted is re-validated. A patch that
// changes nothing writes nothing and isn't audited.
export async function updateRules(
  deps: EditDeps,
  actor: Actor,
  patch: Partial<Rules>,
): Promise<League> {
  assertCommissioner(actor);
  return deps.db.transaction(async (tx) => {
    const row = await lockForCommissionerEdit(tx, actor);
    const before = rulesOf(row);
    const after: Rules = {
      targetScore: patch.targetScore ?? before.targetScore,
      winBy: patch.winBy ?? before.winBy,
      sinkPoints: patch.sinkPoints ?? before.sinkPoints,
      sinkEndsGame: patch.sinkEndsGame ?? before.sinkEndsGame,
    };
    if (!changed(before, after)) return toLeague(row);

    const [updated] = await tx.update(leagues).set(after).where(eq(leagues.id, row.id)).returning();
    if (!updated) throw new Error('locked league vanished');
    await recordAudit(
      tx,
      actor,
      {
        action: 'league.rules_updated',
        targetType: 'league',
        targetId: row.id,
        actorWasParticipant: false,
        details: { before, after },
      },
      deps.clock.now(),
    );
    return toLeague(updated);
  });
}

// A new confirmation window applies to games submitted from now on; a game's window is
// fixed when it is first submitted (or reopened). Audited like a rules change.
export async function updateSettings(
  deps: EditDeps,
  actor: Actor,
  patch: Partial<LeagueSettings>,
): Promise<League> {
  assertCommissioner(actor);
  return deps.db.transaction(async (tx) => {
    const row = await lockForCommissionerEdit(tx, actor);
    const before = settingsOf(row);
    const after: LeagueSettings = {
      confirmationWindowDays: patch.confirmationWindowDays ?? before.confirmationWindowDays,
      exhibitionCorrectionWindowDays:
        patch.exhibitionCorrectionWindowDays ?? before.exhibitionCorrectionWindowDays,
    };
    if (!changed(before, after)) return toLeague(row);

    const [updated] = await tx.update(leagues).set(after).where(eq(leagues.id, row.id)).returning();
    if (!updated) throw new Error('locked league vanished');
    await recordAudit(
      tx,
      actor,
      {
        action: 'league.settings_updated',
        targetType: 'league',
        targetId: row.id,
        actorWasParticipant: false,
        details: { before, after },
      },
      deps.clock.now(),
    );
    return toLeague(updated);
  });
}
