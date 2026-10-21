import type { Member } from '@beer-die/core';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { invites, leagues, memberships, revisionPlayers } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { recordAudit } from './audit.ts';
import { compareIds, voidOpenRevisions } from './games.ts';
import { lockForCommissionerEdit } from './leagues.ts';
import { type Actor, assertCommissioner } from './membership.ts';
import { settleSeason } from './seasons.ts';
import { leaveTeams, seasonsWithTeamsOf } from './teams.ts';

// A member departs a league when a commissioner removes them or they leave (SPEC §3.5). Their
// membership row stays, as removed or left, so their name stays on the games they played and
// stays reserved, but they lose the league at once. In the same transaction every open revision
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
  status: 'removed' | 'left',
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

// A member leaves the league. The last commissioner can't, so a league always has one; they
// promote someone first. Leaving is the member's own act, so it isn't audited.
export async function leaveLeague(deps: Deps, actor: Actor): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    // The lock setRole and removal take, so the commissioner count below can't go stale.
    await tx
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.id, actor.leagueId))
      .for('no key update');
    const [self] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')));
    // The caller left, or was removed, after the request was authorized.
    if (!self) throw notFound();
    if (self.role === 'commissioner') {
      const [row] = await tx
        .select({ n: count() })
        .from(memberships)
        .where(
          and(
            eq(memberships.leagueId, actor.leagueId),
            eq(memberships.role, 'commissioner'),
            eq(memberships.status, 'approved'),
          ),
        );
      if ((row?.n ?? 0) <= 1) {
        throw new ApiError(
          409,
          'LAST_COMMISSIONER',
          'A league needs at least one commissioner. Promote someone else before you leave',
        );
      }
    }
    await depart(tx, actor.leagueId, actor.id, 'left', now);
  });
}
