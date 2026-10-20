import {
  AUDIT_PAGE_MAX,
  AuditEvent,
  type AuditResponse,
  ForcedConfirmationDetails,
  RosterChangeDetails,
  TeamRejectedDetails,
} from '@beer-die/core';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.ts';
import { auditEvents, memberships, seasons, seasonTeams } from '../db/schema.ts';
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
  // A forced confirmation names the player it was for, and a roster change the players before
  // and after. Names are looked up now, not stored, so the log shows a renamed or anonymized
  // member as they are today.
  const playerIdOf = new Map(
    page.flatMap((row) =>
      row.action === 'game.confirmation_forced'
        ? [[row.id, ForcedConfirmationDetails.parse(row.details).membershipId] as const]
        : [],
    ),
  );
  const rosterChangeOf = new Map(
    page.flatMap((row) =>
      row.action === 'team.roster_updated'
        ? [[row.id, RosterChangeDetails.parse(row.details)] as const]
        : [],
    ),
  );
  const playerIds = new Set([
    ...playerIdOf.values(),
    ...[...rosterChangeOf.values()].flatMap((change) => [...change.before, ...change.after]),
  ]);
  const players =
    playerIds.size === 0
      ? []
      : await db
          .select({ membershipId: memberships.id, displayName: memberships.displayName })
          .from(memberships)
          .where(
            and(eq(memberships.leagueId, actor.leagueId), inArray(memberships.id, [...playerIds])),
          );
  const playerById = new Map(players.map((p) => [p.membershipId, p]));
  const named = (ids: string[]) => ids.map((id) => playerById.get(id));
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
  // And an entry about a team names it and its season.
  const teamIds = [
    ...new Set(page.flatMap((row) => (row.targetType === 'team' ? [row.targetId] : []))),
  ];
  const teamRows =
    teamIds.length === 0
      ? []
      : await db
          .select({
            id: seasonTeams.id,
            name: seasonTeams.name,
            proposedBy: seasonTeams.proposedBy,
            partnerId: seasonTeams.partnerId,
            seasonId: seasons.id,
            seasonName: seasons.name,
          })
          .from(seasonTeams)
          .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId))
          .where(and(eq(seasons.leagueId, actor.leagueId), inArray(seasonTeams.id, teamIds)));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  // A team rejected as a proposal stays as private in the log as it was in the team list
  // (domain/teams.ts): named only to its pair and the commissioners.
  const hidesTeam = (row: { action: string; details: unknown }, team: (typeof teamRows)[number]) =>
    row.action === 'team.rejected' &&
    TeamRejectedDetails.parse(row.details).status === 'proposed' &&
    actor.role !== 'commissioner' &&
    actor.id !== team.proposedBy &&
    actor.id !== team.partnerId;

  // Parsed rather than cast: a row whose stored shape has drifted fails here, loudly,
  // instead of reaching clients.
  const events = page.map(({ actorMembershipId, actorDisplayName, createdAt, ...row }) => {
    const playerId = playerIdOf.get(row.id);
    const rosterChange = rosterChangeOf.get(row.id);
    const team = row.targetType === 'team' ? teamById.get(row.targetId) : undefined;
    return AuditEvent.parse({
      ...row,
      createdAt: createdAt.toISOString(),
      actor: { membershipId: actorMembershipId, displayName: actorDisplayName },
      ...(playerId !== undefined && { player: playerById.get(playerId) }),
      ...(rosterChange !== undefined && {
        roster: { before: named(rosterChange.before), after: named(rosterChange.after) },
      }),
      ...(row.targetType === 'season' && { season: seasonById.get(row.targetId) }),
      ...(team !== undefined && {
        team: hidesTeam(row, team) ? null : { id: team.id, name: team.name },
        season: { id: team.seasonId, name: team.seasonName },
      }),
    });
  });
  return { events, nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}
