import {
  type CreateInviteResponse,
  type Invite,
  type Member,
  type MembershipRole,
  type MyMembership,
  nameKey,
} from '@beer-die/core';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { hit, rateLimitKey } from '../auth/rateLimit.ts';
import { TOKEN_PATTERN } from '../auth/sessions.ts';
import type { Clock } from '../clock.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { invites, leagues, memberships, users } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { MEMBER_PENDING, memberPendingParams } from '../mail/templates.ts';

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A refused join reveals whether a name is taken, so attempts are capped per user. Name
// changes (updateMe) reveal the same, so they spend the same budget.
const JOINS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

// The caller's approved membership in the league named by the route, resolved by
// requireMembership. Every league-scoped query takes `leagueId` from here, never from the
// request.
export type Actor = { id: string; leagueId: string; userId: string; role: MembershipRole };

type Deps = { db: Db; clock: Clock; config: { appOrigin: string; authSecret: string } };

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

export function assertCommissioner(actor: Actor): void {
  if (actor.role !== 'commissioner') {
    throw new ApiError(403, 'FORBIDDEN', 'Only a commissioner can do that');
  }
}

export async function resolveMembership(
  db: Db,
  input: { userId: string; leagueId: string },
): Promise<Actor | null> {
  const [row] = await db
    .select({
      id: memberships.id,
      leagueId: memberships.leagueId,
      userId: memberships.userId,
      role: memberships.role,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.leagueId, input.leagueId),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'approved'),
      ),
    );
  return row ?? null;
}

const myMembershipColumns = {
  id: memberships.id,
  leagueId: memberships.leagueId,
  leagueName: leagues.name,
  displayName: memberships.displayName,
  role: memberships.role,
  status: memberships.status,
  emailNotifications: memberships.emailNotifications,
};

// Pending memberships are listed too, so the app can show "awaiting approval".
export async function listMyMemberships(db: Db, userId: string): Promise<MyMembership[]> {
  return db
    .select(myMembershipColumns)
    .from(memberships)
    .innerJoin(leagues, eq(leagues.id, memberships.leagueId))
    .where(
      and(eq(memberships.userId, userId), inArray(memberships.status, ['pending', 'approved'])),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

const NAME_KEY_UNIQUE = 'memberships_league_name_key_unique';

function violates(err: unknown, constraint: string): boolean {
  const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === '23505' && cause.constraint_name === constraint;
}

// Changes the caller's own display name and email setting in every league they belong to,
// pending or approved; memberships they have left or lost keep the name they had. A name
// someone else holds in any of those leagues (kept names of deleted members included) refuses
// the whole change. Not audited: players acting for themselves aren't.
export async function updateMe(
  deps: Deps,
  userId: string,
  input: { displayName?: string; emailNotifications?: boolean },
): Promise<void> {
  if (input.displayName !== undefined) {
    // Counted outside the transaction, so a refused name still counts.
    const key = rateLimitKey(deps.config.authSecret, 'join', userId);
    if (!(await hit(deps.db, key, JOINS_PER_HOUR, HOUR_MS, deps.clock.now()))) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many name changes. Try again later.');
    }
  }
  const set = {
    ...(input.displayName === undefined
      ? {}
      : { displayName: input.displayName, nameKey: nameKey(input.displayName) }),
    ...(input.emailNotifications === undefined
      ? {}
      : { emailNotifications: input.emailNotifications }),
  };
  await deps.db.transaction(async (tx) => {
    // FOR SHARE first, as joinLeague does, so an account deletion either waits for this or
    // has already marked the account deleted.
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('share');
    if (!account) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    try {
      await tx
        .update(memberships)
        .set(set)
        .where(
          and(eq(memberships.userId, userId), inArray(memberships.status, ['pending', 'approved'])),
        );
    } catch (err) {
      // The unique index decides, so two members racing for one name can't both get it.
      if (violates(err, NAME_KEY_UNIQUE)) {
        throw new ApiError(409, 'NAME_TAKEN', 'That display name is taken in your league');
      }
      throw err;
    }
  });
}

// Creates a pending membership through an invite link and tells the commissioners. Unknown,
// expired, and revoked links are indistinguishable.
export async function joinLeague(
  deps: Deps,
  input: { userId: string; token: string; displayName: string },
): Promise<MyMembership> {
  const now = deps.clock.now();
  // Counted outside the transaction, so a refused attempt still counts.
  const key = rateLimitKey(deps.config.authSecret, 'join', input.userId);
  if (!(await hit(deps.db, key, JOINS_PER_HOUR, HOUR_MS, now))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts to join. Try again later.');
  }
  const invalid = new ApiError(404, 'INVITE_INVALID', 'This invite link is invalid or has expired');
  if (!TOKEN_PATTERN.test(input.token)) throw invalid;

  return deps.db.transaction(async (tx) => {
    // FOR SHARE holds the account until this commits, so an account deletion
    // (domain/departures.ts) either waits for the join and deletes its membership, or has
    // already marked the account deleted and the join is refused.
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .for('share');
    if (!account) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    const [invite] = await tx
      .select({ leagueId: invites.leagueId })
      .from(invites)
      .where(
        and(
          eq(invites.tokenSha256, sha256Hex(input.token)),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now),
        ),
      );
    if (!invite) throw invalid;

    // Both unique constraints (one membership per user, one holder per name) are checked by
    // the insert itself, so concurrent joins can't slip past a read-then-write gap.
    const [created] = await tx
      .insert(memberships)
      .values({
        leagueId: invite.leagueId,
        userId: input.userId,
        displayName: input.displayName,
        nameKey: nameKey(input.displayName),
        role: 'member',
        status: 'pending',
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    if (!created) {
      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.leagueId, invite.leagueId), eq(memberships.userId, input.userId)),
        );
      throw existing
        ? new ApiError(409, 'ALREADY_MEMBER', 'You already belong to this league')
        : new ApiError(409, 'NAME_TAKEN', 'That display name is taken in this league');
    }

    const commissioners = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.leagueId, invite.leagueId),
          eq(memberships.role, 'commissioner'),
          eq(memberships.status, 'approved'),
          eq(memberships.emailNotifications, true),
        ),
      );
    for (const { userId } of commissioners) {
      await enqueueEmail(tx, {
        userId,
        template: MEMBER_PENDING,
        params: memberPendingParams(input.displayName, `${deps.config.appOrigin}/members`),
        now,
      });
    }

    const [membership] = await tx
      .select(myMembershipColumns)
      .from(memberships)
      .innerJoin(leagues, eq(leagues.id, memberships.leagueId))
      .where(eq(memberships.id, created.id));
    if (!membership) throw new Error('inserted membership is missing');
    return membership;
  });
}

const memberColumns = {
  id: memberships.id,
  displayName: memberships.displayName,
  role: memberships.role,
  status: memberships.status,
};

// Everyone sees approved members. Commissioners also see pending members, and only for
// those do they see an email (SPEC §4, Privacy).
export async function listMembers(db: Db, actor: Actor): Promise<Member[]> {
  const commissioner = actor.role === 'commissioner';
  const rows = await db
    .select({ ...memberColumns, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.leagueId, actor.leagueId),
        inArray(memberships.status, commissioner ? ['approved', 'pending'] : ['approved']),
      ),
    )
    .orderBy(asc(memberships.nameKey));
  return rows.map(({ email, ...member }) =>
    commissioner && member.status === 'pending' && email ? { ...member, email } : member,
  );
}

// 404 when the membership isn't in the actor's league; otherwise the given conflict.
async function missingOr(db: Db, actor: Actor, membershipId: string, conflict: ApiError) {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.leagueId, actor.leagueId)));
  return row ? conflict : notFound();
}

const notPending = () => new ApiError(409, 'NOT_PENDING', 'That member is not awaiting approval');

export async function approveMember(db: Db, actor: Actor, membershipId: string): Promise<Member> {
  assertCommissioner(actor);
  const [row] = await db
    .update(memberships)
    .set({ status: 'approved' })
    .where(
      and(
        eq(memberships.id, membershipId),
        eq(memberships.leagueId, actor.leagueId),
        eq(memberships.status, 'pending'),
      ),
    )
    .returning(memberColumns);
  if (!row) throw await missingOr(db, actor, membershipId, notPending());
  return row;
}

// A pending member has no history, so rejecting deletes the row and frees the name.
export async function rejectMember(db: Db, actor: Actor, membershipId: string): Promise<void> {
  assertCommissioner(actor);
  const [row] = await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.id, membershipId),
        eq(memberships.leagueId, actor.leagueId),
        eq(memberships.status, 'pending'),
      ),
    )
    .returning({ id: memberships.id });
  if (!row) throw await missingOr(db, actor, membershipId, notPending());
}

// Role changes in a league are serialized on the league row, and the actor's own role is
// re-read under that lock, so no interleaving (two commissioners demoting each other, say)
// can leave the league without a commissioner.
export async function setRole(
  db: Db,
  actor: Actor,
  membershipId: string,
  role: MembershipRole,
): Promise<Member> {
  assertCommissioner(actor);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.id, actor.leagueId))
      .for('update');
    const [self] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')));
    assertCommissioner({ ...actor, role: self?.role ?? 'member' });

    const [target] = await tx
      .select(memberColumns)
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.leagueId, actor.leagueId)));
    if (!target) throw notFound();
    if (target.status !== 'approved') {
      throw new ApiError(409, 'NOT_APPROVED', 'Only approved members can change role');
    }
    if (target.role === role) return target;

    if (role === 'member') {
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
        throw new ApiError(409, 'LAST_COMMISSIONER', 'A league needs at least one commissioner');
      }
    }

    const [updated] = await tx
      .update(memberships)
      .set({ role })
      .where(eq(memberships.id, membershipId))
      .returning(memberColumns);
    if (!updated) throw new Error('locked membership vanished');
    return updated;
  });
}

const inviteColumns = {
  id: invites.id,
  createdAt: invites.createdAt,
  expiresAt: invites.expiresAt,
};

function toInvite(row: { id: string; createdAt: Date; expiresAt: Date }): Invite {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// The link carries the only copy of the token; just its SHA-256 is stored.
export async function createInvite(deps: Deps, actor: Actor): Promise<CreateInviteResponse> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  const token = randomBytes(32).toString('base64url');
  const [row] = await deps.db
    .insert(invites)
    .values({
      leagueId: actor.leagueId,
      tokenSha256: sha256Hex(token),
      createdBy: actor.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    })
    .returning(inviteColumns);
  if (!row) throw new Error('insert returned no invite');
  return { invite: toInvite(row), url: `${deps.config.appOrigin}/join/${token}` };
}

export async function listInvites(db: Db, actor: Actor, now: Date): Promise<Invite[]> {
  assertCommissioner(actor);
  const rows = await db
    .select(inviteColumns)
    .from(invites)
    .where(
      and(
        eq(invites.leagueId, actor.leagueId),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .orderBy(desc(invites.createdAt));
  return rows.map(toInvite);
}

// Idempotent: revoking an already revoked invite keeps its original revocation time.
export async function revokeInvite(
  db: Db,
  actor: Actor,
  inviteId: string,
  now: Date,
): Promise<void> {
  assertCommissioner(actor);
  const [row] = await db
    .update(invites)
    .set({ revokedAt: sql`coalesce(${invites.revokedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(invites.id, inviteId), eq(invites.leagueId, actor.leagueId)))
    .returning({ id: invites.id });
  if (!row) throw notFound();
}
