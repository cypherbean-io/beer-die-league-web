import {
  AUDIT_PAGE_MAX,
  AuditEvent,
  type AuditResponse,
  ForcedConfirmationDetails,
} from '@beer-die/core';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.ts';
import { auditEvents, memberships, seasons } from '../db/schema.ts';
import type { Actor } from './membership.ts';

const DEFAULT_PAGE = 50;

// What a caller supplies; the log adds the id, time, league, and actor, and names any player
// an entry is about when it is read. Distributes over the union, so each action keeps its own
// `details` shape.
type Recordable<E extends AuditEvent> = E extends AuditEvent
  ? Pick<E, 'action' | 'targetType' | 'targetId' | 'actorWasParticipant' | 'details'>
  : never;
export type AuditRecord = Recordable<AuditEvent>;

// Runs inside the transaction that makes the change, so the action and its entry commit
// together or not at all.
export async function recordAudit(
  tx: Tx,
  actor: Actor,
  record: AuditRecord,
  now: Date,
): Promise<void> {
  await tx.insert(auditEvents).values({
    ...record,
    leagueId: actor.leagueId,
    actorMembershipId: actor.id,
    createdAt: now,
  });
}

// Every member may read the log. Newest first, paging backwards with a `before` cursor.
export async function listAudit(
  db: Db,
  actor: Actor,
  query: { before?: string | undefined; limit?: number | undefined },
): Promise<AuditResponse> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE, AUDIT_PAGE_MAX);
  const rows = await db
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      actorMembershipId: auditEvents.actorMembershipId,
      actorDisplayName: memberships.displayName,
      actorWasParticipant: auditEvents.actorWasParticipant,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      details: auditEvents.details,
    })
    .from(auditEvents)
    .innerJoin(memberships, eq(memberships.id, auditEvents.actorMembershipId))
    .where(
      and(
        eq(auditEvents.leagueId, actor.leagueId),
        query.before === undefined ? undefined : lt(auditEvents.id, query.before),
      ),
    )
    .orderBy(desc(auditEvents.id))
    // One extra row tells whether another page exists.
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  // A forced confirmation names the player it was for. The name is looked up now, not stored,
  // so the log shows a renamed or anonymized member as they are today.
  const playerIdOf = new Map(
    page.flatMap((row) =>
      row.action === 'game.confirmation_forced'
        ? [[row.id, ForcedConfirmationDetails.parse(row.details).membershipId] as const]
        : [],
    ),
  );
  const players =
    playerIdOf.size === 0
      ? []
      : await db
          .select({ membershipId: memberships.id, displayName: memberships.displayName })
          .from(memberships)
          .where(
            and(
              eq(memberships.leagueId, actor.leagueId),
              inArray(memberships.id, [...playerIdOf.values()]),
            ),
          );
  const playerById = new Map(players.map((p) => [p.membershipId, p]));
  // Likewise an entry about a season names it as it is now.
  const seasonIds = [
    ...new Set(page.flatMap((row) => (row.targetType === 'season' ? [row.targetId] : []))),
  ];
  const seasonRows =
    seasonIds.length === 0
      ? []
      : await db
          .select({ id: seasons.id, name: seasons.name })
          .from(seasons)
          .where(and(eq(seasons.leagueId, actor.leagueId), inArray(seasons.id, seasonIds)));
  const seasonById = new Map(seasonRows.map((s) => [s.id, s]));

  // Parsed rather than cast: a row whose stored shape has drifted fails here, loudly,
  // instead of reaching clients.
  const events = page.map(({ actorMembershipId, actorDisplayName, createdAt, ...row }) => {
    const playerId = playerIdOf.get(row.id);
    return AuditEvent.parse({
      ...row,
      createdAt: createdAt.toISOString(),
      actor: { membershipId: actorMembershipId, displayName: actorDisplayName },
      ...(playerId !== undefined && { player: playerById.get(playerId) }),
      ...(row.targetType === 'season' && { season: seasonById.get(row.targetId) }),
    });
  });
  return { events, nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}
