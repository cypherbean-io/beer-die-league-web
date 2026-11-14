import {
  type CreateInviteResponse,
  type Invite,
  type Member,
  type MembershipRole,
  type MyMembership,
  nameKey,
} from '@beer-die/core';
import { randomBytes } from 'node:crypto';
import {
  and,
  type AnyColumn,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import { hit, rateLimitKey } from '../auth/rateLimit.ts';
import { TOKEN_PATTERN } from '../auth/sessions.ts';
import type { Clock } from '../clock.ts';
import { sha256Hex } from '../crypto.ts';
import type { Db, Tx } from '../db/client.ts';
import { invites, leagues, memberships, releasedNames, users } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { enqueueEmail } from '../mail/outbox.ts';
import { MEMBER_PENDING, memberPendingParams } from '../mail/templates.ts';
import { recordAudit } from './audit.ts';

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A refused join reveals whether a name is taken, so attempts are capped per user. Name
// changes (updateMe) reveal the same, so they spend the same budget.
const JOINS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
// How long a name an approved member gave up stays theirs alone to take back. History shows a
// member's current name, so without this someone could rename into a name the league still
// knows another member by, and that member's past games would seem to be the newcomer's.
export const NAME_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
// The most names held for one membership at a time, so renaming can't take names out of use
// faster than the holds lapse.
const MAX_HELD_NAMES = 5;

// The caller's approved membership in the league named by the route, resolved by
// requireMembership. Every league-scoped query takes `leagueId` from here, never from the
// request.
export type Actor = { id: string; leagueId: string; userId: string; role: MembershipRole };

type Deps = { db: Db; clock: Clock; config: { appOrigin: string; authSecret: string } };

// What an audited commissioner action needs: the clock stamps its log entry.
type AuditedDeps = { db: Db; clock: Clock };

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

// Whether the member a `memberships.status` column (or an alias's) belongs to has left, been
// removed, or deleted their account: the `former` flag next to their name on games, stats,
// and rosters (SPEC §4).
export const formerMember = (status: AnyColumn) =>
  sql<boolean>`${status} in ('removed', 'left', 'deleted')`;

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

const nameTaken = (message: string) => new ApiError(409, 'NAME_TAKEN', message);

// Refuses `key` in any of `leagueIds` where it is held for a member who gave it up. The caller
// has already written the name and ended any hold of its own on it, so a hold still standing
// is someone else's.
//
// This runs after the write on purpose. A rename moves the name out of the unique index and
// records the hold in one transaction, so whoever takes the freed name next waited on that
// index for the rename to commit, and this statement, starting afterwards, sees the hold.
async function assertNotHeld(
  tx: Tx,
  leagueIds: string[],
  key: string,
  now: Date,
  message: string,
): Promise<void> {
  const [held] = await tx
    .select({ id: releasedNames.id })
    .from(releasedNames)
    .where(
      and(
        inArray(releasedNames.leagueId, leagueIds),
        eq(releasedNames.nameKey, key),
        gt(releasedNames.releasedAt, new Date(now.getTime() - NAME_HOLD_MS)),
      ),
    )
    .limit(1);
  if (held) throw nameTaken(message);
}

type Renamed = { id: string; leagueId: string; nameKey: string; status: string };

// Keeps the holds in step with a rename to `key`, written just before by the caller: `before`
// is the caller's memberships as they were. Taking back a name of one's own ends its hold;
// the name left behind is held, where the member was approved (a pending member has no
// history to protect).
async function holdReleasedNames(tx: Tx, before: Renamed[], key: string, now: Date) {
  const changed = before.filter((m) => m.nameKey !== key);
  if (changed.length === 0) return;
  const ids = changed.map((m) => m.id);
  await tx
    .delete(releasedNames)
    .where(and(inArray(releasedNames.membershipId, ids), eq(releasedNames.nameKey, key)));
  await assertNotHeld(
    tx,
    changed.map((m) => m.leagueId),
    key,
    now,
    'That display name is taken in your league',
  );

  const released = changed.filter((m) => m.status === 'approved');
  if (released.length === 0) return;
  // A row already there is a lapsed hold from before this member had the name: while they
  // had it, nobody else could give it up.
  await tx
    .insert(releasedNames)
    .values(
      released.map((m) => ({
        leagueId: m.leagueId,
        nameKey: m.nameKey,
        membershipId: m.id,
        releasedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [releasedNames.leagueId, releasedNames.nameKey],
      set: { membershipId: sql`excluded.membership_id`, releasedAt: sql`excluded.released_at` },
    });
  const [over] = await tx
    .select({ membershipId: releasedNames.membershipId })
    .from(releasedNames)
    .where(
      and(
        inArray(releasedNames.membershipId, ids),
        gt(releasedNames.releasedAt, new Date(now.getTime() - NAME_HOLD_MS)),
      ),
    )
    .groupBy(releasedNames.membershipId)
    .having(sql`count(*) > ${MAX_HELD_NAMES}`)
    .limit(1);
  if (over) {
    throw new ApiError(
      409,
      'TOO_MANY_NAME_CHANGES',
      'You have changed your name too many times. Go back to a name you used before, or try again later.',
    );
  }
}

// Changes the caller's own display name and email setting in every league they belong to,
// pending or approved; memberships they have left or lost keep the name they had. A name
// someone else holds in any of those leagues (kept names of deleted members included), or
// that is held for a member who gave it up, refuses the whole change. Not audited: players
// acting for themselves aren't.
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
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    // FOR SHARE first, as joinLeague does, so an account deletion either waits for this or
    // has already marked the account deleted.
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('share');
    if (!account) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const mine = and(
      eq(memberships.userId, userId),
      inArray(memberships.status, ['pending', 'approved']),
    );
    // The names being given up, read under the lock the update takes anyway.
    const before =
      input.displayName === undefined
        ? []
        : await tx
            .select({
              id: memberships.id,
              leagueId: memberships.leagueId,
              nameKey: memberships.nameKey,
              status: memberships.status,
            })
            .from(memberships)
            .where(mine)
            .orderBy(asc(memberships.id))
            .for('update');
    try {
      await tx.update(memberships).set(set).where(mine);
    } catch (err) {
      // The unique index decides, so two members racing for one name can't both get it.
      if (violates(err, NAME_KEY_UNIQUE)) {
        throw nameTaken('That display name is taken in your league');
      }
      throw err;
    }
    if (input.displayName !== undefined) {
      await holdReleasedNames(tx, before, nameKey(input.displayName), now);
    }
  });
}

// Creates a pending membership through an invite link and tells the commissioners. Unknown,
// expired, revoked, and used-up links are indistinguishable. Each join uses one of the link's
// `max_joins`, which bounds the names a leaked link can reserve and the mail it can send
// commissioners.
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

    // Claims one of the link's joins. The update locks the invite, so concurrent joins take
    // turns and can't overshoot the limit; a join refused below rolls its claim back.
    const [invite] = await tx
      .update(invites)
      .set({ joinCount: sql`${invites.joinCount} + 1` })
      .where(
        and(
          eq(invites.tokenSha256, sha256Hex(input.token)),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now),
          lt(invites.joinCount, invites.maxJoins),
        ),
      )
      .returning({ leagueId: invites.leagueId });
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
        : nameTaken('That display name is taken in this league');
    }
    // A name a member gave up is still theirs to take back.
    await assertNotHeld(
      tx,
      [invite.leagueId],
      nameKey(input.displayName),
      now,
      'That display name is taken in this league',
    );

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
async function missingOr(db: Db | Tx, actor: Actor, membershipId: string, conflict: ApiError) {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.leagueId, actor.leagueId)));
  return row ? conflict : notFound();
}

const notPending = () => new ApiError(409, 'NOT_PENDING', 'That member is not awaiting approval');

// Locks the league row and re-reads the actor's role under it, so a commissioner demoted while
// the request waited can't act, and the log never names as actor someone who no longer was
// one. lockForCommissionerEdit (domain/leagues.ts) does the same for every other audited
// commissioner action; that module imports this one, so the few lines are repeated here.
async function lockLeagueAsCommissioner(
  tx: Tx,
  actor: Actor,
  strength: 'update' | 'no key update',
): Promise<void> {
  await tx
    .select({ id: leagues.id })
    .from(leagues)
    .where(eq(leagues.id, actor.leagueId))
    .for(strength);
  const [self] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, actor.id), eq(memberships.status, 'approved')));
  assertCommissioner({ ...actor, role: self?.role ?? 'member' });
}

// Lets a pending member into the league. Audited: it decides who can play and be played with.
// The league lock comes before the member's row, the order a departure takes them in
// (domain/departures.ts).
export async function approveMember(
  deps: AuditedDeps,
  actor: Actor,
  membershipId: string,
): Promise<Member> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await lockLeagueAsCommissioner(tx, actor, 'no key update');
    const [row] = await tx
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
    if (!row) throw await missingOr(tx, actor, membershipId, notPending());
    await recordAudit(
      tx,
      actor,
      {
        action: 'member.approved',
        targetType: 'membership',
        targetId: row.id,
        actorWasParticipant: false,
        details: {},
      },
      now,
    );
    return row;
  });
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
// can leave the league without a commissioner. A change is audited, since it grants or takes
// away every commissioner power; setting the role a member already has changes nothing and
// isn't.
export async function setRole(
  deps: AuditedDeps,
  actor: Actor,
  membershipId: string,
  role: MembershipRole,
): Promise<Member> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await lockLeagueAsCommissioner(tx, actor, 'update');

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
    await recordAudit(
      tx,
      actor,
      {
        action: 'member.role_changed',
        targetType: 'membership',
        targetId: updated.id,
        actorWasParticipant: false,
        details: { before: target.role, after: role },
      },
      now,
    );
    return updated;
  });
}

const inviteColumns = {
  id: invites.id,
  createdAt: invites.createdAt,
  expiresAt: invites.expiresAt,
  maxJoins: invites.maxJoins,
  joinCount: invites.joinCount,
};

function toInvite(row: {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  maxJoins: number;
  joinCount: number;
}): Invite {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    maxJoins: row.maxJoins,
    joinCount: row.joinCount,
  };
}

// The link carries the only copy of the token; just its SHA-256 is stored. It admits
// `maxJoins` people and then stops working.
export async function createInvite(
  deps: Deps,
  actor: Actor,
  input: { maxJoins: number },
): Promise<CreateInviteResponse> {
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
      maxJoins: input.maxJoins,
    })
    .returning(inviteColumns);
  if (!row) throw new Error('insert returned no invite');
  return { invite: toInvite(row), url: `${deps.config.appOrigin}/join/${token}` };
}

// The links that still work: not revoked, expired, or used up.
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
        lt(invites.joinCount, invites.maxJoins),
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
