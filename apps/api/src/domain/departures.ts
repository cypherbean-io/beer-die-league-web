import { type Member, nameKey } from '@beer-die/core';
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import {
  authCodes,
  emailOutbox,
  invites,
  leagues,
  memberships,
  revisionPlayers,
  sessions,
  users,
} from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { recordAudit } from './audit.ts';
import { compareIds, voidOpenRevisions } from './games.ts';
import { lockForCommissionerEdit } from './leagues.ts';
import { type Actor, assertCommissioner } from './membership.ts';
import { settleSeason } from './seasons.ts';
import { leaveTeams, seasonsWithTeamsOf } from './teams.ts';

// A member departs a league when a commissioner removes them, they leave, or they delete their
// account (SPEC §3.5). Their membership row stays, as removed, left, or deleted, so their games
// keep naming them, but they lose the league at once. In the same transaction every open revision
// they play in is voided (domain/games.ts), they come off their teams in every season not yet
// finalized (domain/teams.ts), and every invite link they created is revoked, since they hold
// its token. Their confirmed games keep counting.
//
// Lock order: the league row, the member's row, the games they play in by id, then seasons by
// id. A write that holds the member's row FOR SHARE takes it before any game or season lock
// (domain/games.ts, domain/teams.ts), or after the league lock, so a departure waits for every
// such write in flight and then sees what it committed. The league row is held FOR NO KEY
// UPDATE, which serializes departures with each other, with role changes, and with commissioner
// edits, without blocking the foreign-key checks of a game write that a departure waits for.

type Deps = { db: Db; clock: Clock };

type Voided = Awaited<ReturnType<typeof voidOpenRevisions>>['voided'];

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

const memberColumns = {
  id: memberships.id,
  displayName: memberships.displayName,
  role: memberships.role,
  status: memberships.status,
};

// Marks an approved member as gone and closes out everything of theirs still open, as above.
// The caller holds the league lock. Returns the games voided.
async function depart(
  tx: Tx,
  leagueId: string,
  membershipId: string,
  status: 'removed' | 'left' | 'deleted',
  now: Date,
): Promise<Voided> {
  // Waits for every write holding the member's row FOR SHARE to commit.
  const [gone] = await tx
    .update(memberships)
    .set({ status })
    .where(
      and(
        eq(memberships.id, membershipId),
        eq(memberships.leagueId, leagueId),
        eq(memberships.status, 'approved'),
      ),
    )
    .returning({ id: memberships.id });
  if (!gone) throw new Error('departing member is not approved');
  await tx
    .update(invites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(invites.leagueId, leagueId),
        eq(invites.createdBy, membershipId),
        isNull(invites.revokedAt),
      ),
    );

  const { voided, seasonIds } = await voidOpenRevisions(tx, leagueId, membershipId, now);
  const touched = new Set([
    ...seasonIds,
    ...(await seasonsWithTeamsOf(tx, leagueId, membershipId)),
  ]);
  for (const seasonId of [...touched].sort(compareIds)) {
    // Settling a season whose game was closed may finalize it, whose teams then stay as they
    // finished.
    const season = await settleSeason(tx, seasonId, now);
    if (season.status !== 'finalized') await leaveTeams(tx, season.id, membershipId, now);
  }
  return voided;
}

// A commissioner removes another approved member. Removing them again returns them as they
// are. The removal is audited with the games it voided, flagged when the commissioner played in
// one. A commissioner leaves rather than removing themselves, so that the last-commissioner
// check lives in one place.
export async function removeMember(
  deps: Deps,
  actor: Actor,
  membershipId: string,
): Promise<Member> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await lockForCommissionerEdit(tx, actor);
    const [target] = await tx
      .select(memberColumns)
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.leagueId, actor.leagueId)));
    if (!target) throw notFound();
    if (target.id === actor.id) {
      throw new ApiError(409, 'REMOVE_SELF', 'Leave the league instead of removing yourself');
    }
    if (target.status === 'removed') return target;
    if (target.status !== 'approved') {
      throw new ApiError(409, 'NOT_APPROVED', 'Only approved members can be removed');
    }

    const voided = await depart(tx, actor.leagueId, target.id, 'removed', now);
    const [seat] =
      voided.length === 0
        ? []
        : await tx
            .select({ id: revisionPlayers.id })
            .from(revisionPlayers)
            .where(
              and(
                inArray(
                  revisionPlayers.revisionId,
                  voided.map((v) => v.revisionId),
                ),
                eq(revisionPlayers.membershipId, actor.id),
              ),
            )
            .limit(1);
    await recordAudit(
      tx,
      actor,
      {
        action: 'member.removed',
        targetType: 'membership',
        targetId: target.id,
        actorWasParticipant: seat !== undefined,
        details: { voidedGameIds: voided.map((v) => v.gameId) },
      },
      now,
    );
    return { ...target, status: 'removed' };
  });
}

// The lock every departure takes first, which setRole and commissioner edits also take, so a
// commissioner count read under it can't go stale.
async function lockLeague(tx: Tx, leagueId: string): Promise<void> {
  await tx
    .select({ id: leagues.id })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .for('no key update');
}

// The league's approved commissioners and members. The caller holds the league lock. An
// approval doesn't take it, but only a commissioner can approve, so a member count can go stale
// only through the deleting commissioner's own approval.
async function headcount(
  tx: Tx,
  leagueId: string,
): Promise<{ commissioners: number; members: number }> {
  const [row] = await tx
    .select({
      commissioners:
        sql<number>`count(*) filter (where ${memberships.role} = 'commissioner')`.mapWith(Number),
      members: count(),
    })
    .from(memberships)
    .where(and(eq(memberships.leagueId, leagueId), eq(memberships.status, 'approved')));
  return { commissioners: row?.commissioners ?? 0, members: row?.members ?? 0 };
}

// A member leaves the league. The last commissioner can't, so a league always has one; they
// promote someone first. Leaving is the member's own act, so it isn't audited.
export async function leaveLeague(deps: Deps, actor: Actor): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await lockLeague(tx, actor.leagueId);
    const [self] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')));
    // The caller left, or was removed, after the request was authorized.
    if (!self) throw notFound();
    if (self.role === 'commissioner' && (await headcount(tx, actor.leagueId)).commissioners <= 1) {
      throw new ApiError(
        409,
        'LAST_COMMISSIONER',
        'A league needs at least one commissioner. Promote someone else before you leave',
      );
    }
    await depart(tx, actor.leagueId, actor.id, 'left', now);
  });
}

// A user deletes their account (SPEC §4, Privacy). They depart every league they belong to,
// as deleted, and their name there becomes "Deleted player #N" unless they keep it, in which
// case it stays on their games and stays reserved. A membership awaiting approval has no
// history, so it is deleted, as a rejection does. Then their email, sessions, sign-in codes,
// and queued mail are erased. Confirmed games keep counting, so other players' records don't
// change, and signing up again with the same email creates a new, unlinked user. Like leaving,
// it isn't audited. The last commissioner of a league with other members is refused, as when
// leaving, and then nothing is deleted anywhere.
//
// Lock order: the user row FOR NO KEY UPDATE, each league by id as a departure takes it, the
// user row FOR UPDATE, then the user's sessions, mail, and codes. Marking the row deleted first
// holds off a join (domain/membership.ts) and a sign-in, which lock it harder, without blocking
// the foreign-key check of a write that mails the user. Clearing the email changes a unique
// column, which takes the row FOR UPDATE and so waits for such writes, whose mail is then
// erased; they queue mail as their last step, so they hold nothing a departure needs. Mail a
// write queues after that, having read the user as a recipient before this committed, has no
// recipient, and the worker deletes it (mail/outbox.ts). Verifying a code locks it before the
// user row, so a code it holds is skipped: once the email is cleared, that sign-in creates a
// new user, and the code is theirs.
export async function deleteAccount(
  deps: Deps,
  userId: string,
  keepDisplayName: boolean,
): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ deletedAt: now })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ email: users.email });
    // Another request deleted it after this one was authorized.
    if (!user) return;

    // A join holds the user row FOR SHARE, so every join is either committed by now or
    // refused.
    const joined = await tx
      .select({ leagueId: memberships.leagueId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.leagueId));
    for (const { leagueId } of joined) {
      await departDeleted(tx, leagueId, userId, keepDisplayName, now);
    }

    await tx.update(users).set({ email: null }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(emailOutbox).where(eq(emailOutbox.userId, userId));
    if (user.email) {
      const codes = await tx
        .select({ id: authCodes.id })
        .from(authCodes)
        .where(eq(authCodes.email, user.email))
        .for('update', { skipLocked: true });
      if (codes.length > 0) {
        await tx.delete(authCodes).where(
          inArray(
            authCodes.id,
            codes.map((c) => c.id),
          ),
        );
      }
    }
  });
}

// The deleted user's membership in one league, as above.
async function departDeleted(
  tx: Tx,
  leagueId: string,
  userId: string,
  keepDisplayName: boolean,
  now: Date,
): Promise<void> {
  await lockLeague(tx, leagueId);
  // Waits for an approval in flight, and for every write holding the row FOR SHARE.
  const [self] = await tx
    .select(memberColumns)
    .from(memberships)
    .where(and(eq(memberships.leagueId, leagueId), eq(memberships.userId, userId)))
    .for('update');
  // Rejected since the scan.
  if (!self) return;
  if (self.status === 'pending') {
    await tx.delete(memberships).where(eq(memberships.id, self.id));
    return;
  }
  if (self.status === 'approved') {
    const { commissioners, members } = await headcount(tx, leagueId);
    if (self.role === 'commissioner' && commissioners <= 1 && members > 1) {
      throw new ApiError(
        409,
        'LAST_COMMISSIONER',
        'A league needs at least one commissioner. Promote someone else before you delete your account',
        { leagueId },
      );
    }
    await depart(tx, leagueId, self.id, 'deleted', now);
  }
  // A member who had already left or been removed is anonymized too.
  await tx
    .update(memberships)
    .set({
      status: 'deleted',
      keepNameOnDelete: keepDisplayName,
      ...(keepDisplayName ? {} : await anonymousName(tx, leagueId, self.id)),
    })
    .where(eq(memberships.id, self.id));
}

// "Deleted player #N", numbered in turn among the league's other anonymized members. The
// league lock serializes deletions, and a display name can't hold '#', so the name is always
// free.
async function anonymousName(
  tx: Tx,
  leagueId: string,
  membershipId: string,
): Promise<{ displayName: string; nameKey: string }> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.leagueId, leagueId),
        eq(memberships.status, 'deleted'),
        eq(memberships.keepNameOnDelete, false),
        ne(memberships.id, membershipId),
      ),
    );
  const displayName = `Deleted player #${(row?.n ?? 0) + 1}`;
  return { displayName, nameKey: nameKey(displayName) };
}
