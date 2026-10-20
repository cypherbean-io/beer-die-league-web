import { nameKey, Team } from '@beer-die/core';
import { and, asc, count, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { hit, rateLimitKey } from '../auth/rateLimit.ts';
import type { Clock } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { memberships, seasons, seasonTeams, teamRoster } from '../db/schema.ts';
import { ApiError } from '../http.ts';
import { recordAudit } from './audit.ts';
import { lockForCommissionerEdit } from './leagues.ts';
import { type Actor, assertCommissioner } from './membership.ts';
import { finalizeIfSettled } from './seasons.ts';

// Teams (SPEC §3.7). A member proposes a team with a partner, the partner accepts, and a
// commissioner approves it, all while the season is a draft or active. Until a team is
// approved, either player can withdraw it and a commissioner can reject it; once it is, a
// commissioner can change its roster. Both last until the season is finalized.
//
// A player joins the roster when they commit to the team: the proposer on proposing, the
// partner on accepting. The roster's partial unique index then keeps each player on one team
// per season, and nobody is held by a team they haven't agreed to. Withdrawing or rejecting a
// team closes its rows, which frees its players.
//
// Every member sees a team once both players have agreed to it. Before that, and once it is
// withdrawn or rejected, only its two players and the commissioners do, so a member's name is
// never shown to the league on a team they didn't agree to.
//
// Every team write holds its season's row lock, FOR NO KEY UPDATE like any season write. That
// serializes the season's team writes, and keeps the season from ending or finalizing under
// one. A commissioner's write takes the league lock first, as every commissioner edit does, so
// the lock order is league → season, as in domain/seasons.ts.

// Counts refused attempts too. Far above what a real league needs.
export const TEAM_PROPOSALS_PER_HOUR = 10;
// Withdrawn and rejected teams are kept, so each member's proposals in a season are capped.
export const TEAM_PROPOSALS_PER_SEASON = 10;
const HOUR_MS = 60 * 60 * 1000;

type Deps = { db: Db; clock: Clock };

type SeasonRow = typeof seasons.$inferSelect;
type TeamRow = typeof seasonTeams.$inferSelect;
type TeamPlayer = Team['players'][number];

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

const notPending = (action: string) =>
  new ApiError(409, 'TEAM_NOT_PENDING', `Only a team awaiting approval can be ${action}`);

const seasonFinalized = () =>
  new ApiError(409, 'SEASON_FINALIZED', 'This season is finalized, so its teams are locked');

const proposer = alias(memberships, 'proposer');
const partner = alias(memberships, 'partner');

type NamedTeam = { team: TeamRow; proposerName: string; partnerName: string };

// Teams with the names of the pair that proposed each, by name.
function selectTeams(db: Db | Tx, where: SQL | undefined): Promise<NamedTeam[]> {
  return db
    .select({
      team: seasonTeams,
      proposerName: proposer.displayName,
      partnerName: partner.displayName,
    })
    .from(seasonTeams)
    .innerJoin(proposer, eq(proposer.id, seasonTeams.proposedBy))
    .innerJoin(partner, eq(partner.id, seasonTeams.partnerId))
    .where(where)
    .orderBy(asc(seasonTeams.nameKey), asc(seasonTeams.id));
}

// The open roster rows of a season's teams, or of one of them, in the order their players
// joined: the proposer, the partner, then anyone a commissioner added.
async function openRosters(
  db: Db | Tx,
  seasonId: string,
  teamId?: string,
): Promise<Map<string, TeamPlayer[]>> {
  const rows = await db
    .select({
      teamId: teamRoster.teamId,
      membershipId: teamRoster.membershipId,
      displayName: memberships.displayName,
    })
    .from(teamRoster)
    .innerJoin(memberships, eq(memberships.id, teamRoster.membershipId))
    .where(
      and(
        eq(teamRoster.seasonId, seasonId),
        teamId === undefined ? undefined : eq(teamRoster.teamId, teamId),
        isNull(teamRoster.validTo),
      ),
    )
    .orderBy(asc(teamRoster.validFrom), asc(teamRoster.id));
  const byTeam = new Map<string, TeamPlayer[]>();
  for (const { teamId: id, ...player } of rows) byTeam.set(id, [...(byTeam.get(id) ?? []), player]);
  return byTeam;
}

function toTeam(
  { team, proposerName, partnerName }: NamedTeam,
  rosters: Map<string, TeamPlayer[]>,
): Team {
  // Parsed rather than cast, like a season: a drifted row fails here, not in a client.
  return Team.parse({
    id: team.id,
    seasonId: team.seasonId,
    name: team.name,
    status: team.status,
    proposedBy: team.proposedBy,
    // Only an approved team's roster can change, so any other team's players are the pair it
    // was proposed with.
    players:
      team.status === 'approved'
        ? (rosters.get(team.id) ?? [])
        : [
            { membershipId: team.proposedBy, displayName: proposerName },
            { membershipId: team.partnerId, displayName: partnerName },
          ],
    createdAt: team.createdAt.toISOString(),
  });
}

async function loadTeam(tx: Tx, teamId: string): Promise<Team> {
  const [named] = await selectTeams(tx, eq(seasonTeams.id, teamId));
  if (!named) throw new Error('team of a locked season vanished');
  return toTeam(named, await openRosters(tx, named.team.seasonId, teamId));
}

async function playerIdsOf(tx: Tx, team: TeamRow): Promise<string[]> {
  if (team.status !== 'approved') return [team.proposedBy, team.partnerId];
  const roster = (await openRosters(tx, team.seasonId, team.id)).get(team.id) ?? [];
  return roster.map((p) => p.membershipId);
}

// The teams in a season of the caller's league, by name: those both players have agreed to,
// and, for a commissioner, every other; for anyone else, only the others they are one of the
// pair of. A season outside the caller's league is a 404, like an unknown one.
export async function listTeams(db: Db, actor: Actor, seasonId: string): Promise<Team[]> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.leagueId, actor.leagueId)));
  if (!season) throw notFound();
  const named = await selectTeams(
    db,
    and(
      eq(seasonTeams.seasonId, season.id),
      actor.role === 'commissioner'
        ? undefined
        : or(
            inArray(seasonTeams.status, ['accepted', 'approved']),
            eq(seasonTeams.proposedBy, actor.id),
            eq(seasonTeams.partnerId, actor.id),
          ),
    ),
  );
  const rosters = await openRosters(db, season.id);
  return named.map((team) => toTeam(team, rosters));
}

async function lockSeason(tx: Tx, actor: Actor, seasonId: string): Promise<SeasonRow> {
  const [season] = await tx
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.leagueId, actor.leagueId)))
    .for('no key update');
  if (!season) throw notFound();
  return season;
}

// Locks the team's season, under which the team can't change, then reads the team. A team
// outside the caller's league is a 404, like an unknown one.
async function lockTeam(
  tx: Tx,
  actor: Actor,
  teamId: string,
): Promise<{ season: SeasonRow; team: TeamRow }> {
  // A team never changes season, so this unlocked read finds the season to lock.
  const [found] = await tx
    .select({ seasonId: seasonTeams.seasonId })
    .from(seasonTeams)
    .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId))
    .where(and(eq(seasonTeams.id, teamId), eq(seasons.leagueId, actor.leagueId)));
  if (!found) throw notFound();
  const season = await lockSeason(tx, actor, found.seasonId);
  const [team] = await tx.select().from(seasonTeams).where(eq(seasonTeams.id, teamId));
  if (!team) throw new Error('team of a locked season vanished');
  return { season, team };
}

// Teams form only while their season is a draft or active.
function assertForming(season: SeasonRow): void {
  if (season.status !== 'draft' && season.status !== 'active') {
    throw new ApiError(409, 'SEASON_ENDED', 'This season has ended, so no more teams can form');
  }
}

// Which of `ids` aren't approved members of the caller's league. FOR SHARE holds the rest as
// approved until the write commits, so a concurrent removal waits for it and then sees the
// roster row it has to close.
async function strangers(tx: Tx, actor: Actor, ids: string[]): Promise<string[]> {
  const approved = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.leagueId, actor.leagueId),
        inArray(memberships.id, ids),
        eq(memberships.status, 'approved'),
      ),
    )
    .for('share');
  const found = new Set(approved.map((m) => m.id));
  return ids.filter((id) => !found.has(id));
}

const notApprovedMember = (path: Array<string | number>) => ({
  path,
  message: 'Not an approved member of this league',
});

// Opens a roster row for each player. The partial unique index refuses a player still on a
// team this season; the ones refused are returned.
async function join(tx: Tx, team: TeamRow, ids: string[], now: Date): Promise<string[]> {
  const opened = await tx
    .insert(teamRoster)
    .values(
      ids.map((membershipId) => ({
        teamId: team.id,
        seasonId: team.seasonId,
        membershipId,
        validFrom: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ membershipId: teamRoster.membershipId });
  return ids.filter((id) => !opened.some((row) => row.membershipId === id));
}

async function setStatus(tx: Tx, team: TeamRow, status: TeamRow['status']): Promise<void> {
  await tx.update(seasonTeams).set({ status }).where(eq(seasonTeams.id, team.id));
}

// Rejecting or withdrawing a team closes its roster rows, which frees its players.
async function close(
  tx: Tx,
  team: TeamRow,
  status: 'rejected' | 'withdrawn',
  now: Date,
): Promise<void> {
  await tx
    .update(teamRoster)
    .set({ validTo: now })
    .where(and(eq(teamRoster.teamId, team.id), isNull(teamRoster.validTo)));
  await setStatus(tx, team, status);
}

// A write that is allowed until the season is finalized returns null from its transaction once
// it is, and is refused only after that commits, so a season that finalizes on the way in,
// because its last open game's window has lapsed, stays finalized.
function unlessFinalized(result: Team | null): Team {
  if (!result) throw seasonFinalized();
  return result;
}

// A member proposes a team with a partner, joining its roster; the partner joins on accepting.
// Players act for themselves, so none of this is audited.
export async function proposeTeam(
  deps: Deps & { config: { authSecret: string } },
  actor: Actor,
  seasonId: string,
  body: { name: string; partnerId: string },
): Promise<Team> {
  const now = deps.clock.now();
  // Counted outside the transaction, so a refused attempt still counts.
  const key = rateLimitKey(deps.config.authSecret, 'team-propose', actor.id);
  if (!(await hit(deps.db, key, TEAM_PROPOSALS_PER_HOUR, HOUR_MS, now))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many teams proposed. Try again later.');
  }
  const partnerId = body.partnerId.toLowerCase();

  return deps.db.transaction(async (tx) => {
    const season = await lockSeason(tx, actor, seasonId);
    assertForming(season);
    if (partnerId === actor.id) {
      throw new ApiError(422, 'VALIDATION', 'Choose a partner other than yourself', [
        { path: ['partnerId'], message: 'Choose someone else' },
      ]);
    }
    const missing = await strangers(tx, actor, [actor.id, partnerId]);
    // The caller was removed after the request was authorized.
    if (missing.includes(actor.id)) throw notFound();
    if (missing.length > 0) {
      throw new ApiError(422, 'VALIDATION', 'Your partner must be an approved member', [
        notApprovedMember(['partnerId']),
      ]);
    }
    // The season lock serializes proposals, so this count can't go stale.
    const [proposals] = await tx
      .select({ n: count() })
      .from(seasonTeams)
      .where(and(eq(seasonTeams.seasonId, season.id), eq(seasonTeams.proposedBy, actor.id)));
    if ((proposals?.n ?? 0) >= TEAM_PROPOSALS_PER_SEASON) {
      throw new ApiError(
        409,
        'PROPOSAL_LIMIT',
        `You have proposed ${TEAM_PROPOSALS_PER_SEASON} teams this season, the most allowed`,
      );
    }

    // The partial unique index decides a name clash, so concurrent proposals can't slip past
    // a read-then-write gap.
    const [team] = await tx
      .insert(seasonTeams)
      .values({
        seasonId: season.id,
        name: body.name,
        nameKey: nameKey(body.name),
        status: 'proposed',
        proposedBy: actor.id,
        partnerId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!team) {
      throw new ApiError(409, 'TEAM_NAME_TAKEN', 'A team in this season already has that name');
    }
    if ((await join(tx, team, [actor.id], now)).length > 0) {
      throw new ApiError(409, 'ALREADY_ON_TEAM', 'You are already on a team this season');
    }
    // Accepting checks again; this spares the partner a proposal they couldn't accept.
    const [taken] = await tx
      .select({ id: teamRoster.id })
      .from(teamRoster)
      .where(
        and(
          eq(teamRoster.seasonId, season.id),
          eq(teamRoster.membershipId, partnerId),
          isNull(teamRoster.validTo),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ApiError(409, 'ALREADY_ON_TEAM', 'Your partner is already on a team this season');
    }
    return loadTeam(tx, team.id);
  });
}

// The partner accepts, joining the roster, and the team awaits a commissioner. Accepting again
// returns it as it is.
export async function acceptTeam(deps: Deps, actor: Actor, teamId: string): Promise<Team> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const { season, team } = await lockTeam(tx, actor, teamId);
    if (actor.id !== team.partnerId) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the partner asked to join can accept a team');
    }
    if (team.status === 'accepted') return loadTeam(tx, team.id);
    assertForming(season);
    if (team.status !== 'proposed') {
      throw new ApiError(409, 'TEAM_NOT_PROPOSED', 'Only a proposed team can be accepted');
    }
    // The caller was removed after the request was authorized.
    if ((await strangers(tx, actor, [actor.id])).length > 0) throw notFound();
    if ((await join(tx, team, [actor.id], now)).length > 0) {
      throw new ApiError(409, 'ALREADY_ON_TEAM', 'You are already on a team this season');
    }
    await setStatus(tx, team, 'accepted');
    return loadTeam(tx, team.id);
  });
}

// Either player can withdraw a team before it is approved, which is also how the partner
// declines. Withdrawing again returns it as it is.
export async function withdrawTeam(deps: Deps, actor: Actor, teamId: string): Promise<Team> {
  const now = deps.clock.now();
  return unlessFinalized(
    await deps.db.transaction(async (tx) => {
      const { season, team } = await lockTeam(tx, actor, teamId);
      if (!(await playerIdsOf(tx, team)).includes(actor.id)) {
        throw new ApiError(403, 'FORBIDDEN', 'Only a player on the team can withdraw it');
      }
      if (team.status === 'withdrawn') return loadTeam(tx, team.id);
      if ((await finalizeIfSettled(tx, season, now)).status === 'finalized') return null;
      if (team.status !== 'proposed' && team.status !== 'accepted') throw notPending('withdrawn');
      await close(tx, team, 'withdrawn', now);
      return loadTeam(tx, team.id);
    }),
  );
}

// A commissioner approves a team its partner has accepted, so it can play season games.
// Approving it again returns it as it is.
export async function approveTeam(deps: Deps, actor: Actor, teamId: string): Promise<Team> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await lockForCommissionerEdit(tx, actor);
    const { season, team } = await lockTeam(tx, actor, teamId);
    if (team.status === 'approved') return loadTeam(tx, team.id);
    assertForming(season);
    if (team.status !== 'accepted') {
      throw new ApiError(
        409,
        'TEAM_NOT_ACCEPTED',
        'Only a team whose partner has accepted can be approved',
      );
    }

    await setStatus(tx, team, 'approved');
    await recordAudit(
      tx,
      actor,
      {
        action: 'team.approved',
        targetType: 'team',
        targetId: team.id,
        actorWasParticipant: (await playerIdsOf(tx, team)).includes(actor.id),
        details: {},
      },
      now,
    );
    return loadTeam(tx, team.id);
  });
}

// A commissioner rejects a team before it is approved, which frees its players. Rejecting it
// again returns it as it is.
export async function rejectTeam(deps: Deps, actor: Actor, teamId: string): Promise<Team> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  return unlessFinalized(
    await deps.db.transaction(async (tx) => {
      await lockForCommissionerEdit(tx, actor);
      const { season, team } = await lockTeam(tx, actor, teamId);
      if (team.status === 'rejected') return loadTeam(tx, team.id);
      if ((await finalizeIfSettled(tx, season, now)).status === 'finalized') return null;
      if (team.status !== 'proposed' && team.status !== 'accepted') throw notPending('rejected');

      await close(tx, team, 'rejected', now);
      await recordAudit(
        tx,
        actor,
        {
          action: 'team.rejected',
          targetType: 'team',
          targetId: team.id,
          actorWasParticipant: (await playerIdsOf(tx, team)).includes(actor.id),
          details: { status: team.status },
        },
        now,
      );
      return loadTeam(tx, team.id);
    }),
  );
}

// A commissioner gives an approved team a new pair of players. A player who stays keeps their
// roster row; one who leaves has theirs closed, which frees them, and one who joins gets a new
// one. Games already recorded keep the players stored on their revisions. A roster that
// matches the current one writes nothing and isn't audited.
export async function setRoster(
  deps: Deps,
  actor: Actor,
  teamId: string,
  membershipIds: string[],
): Promise<Team> {
  assertCommissioner(actor);
  const now = deps.clock.now();
  const wanted = membershipIds.map((id) => id.toLowerCase());
  return unlessFinalized(
    await deps.db.transaction(async (tx) => {
      await lockForCommissionerEdit(tx, actor);
      const { season, team } = await lockTeam(tx, actor, teamId);
      if ((await finalizeIfSettled(tx, season, now)).status === 'finalized') return null;
      if (team.status !== 'approved') {
        throw new ApiError(
          409,
          'TEAM_NOT_APPROVED',
          "Only an approved team's roster can be changed",
        );
      }

      const before = await playerIdsOf(tx, team);
      const leaving = before.filter((id) => !wanted.includes(id));
      const joining = wanted.filter((id) => !before.includes(id));
      if (leaving.length === 0 && joining.length === 0) return loadTeam(tx, team.id);

      const missing = await strangers(tx, actor, joining);
      if (missing.length > 0) {
        throw new ApiError(
          422,
          'VALIDATION',
          'Every player must be an approved member of this league',
          missing.map((id) => notApprovedMember(['membershipIds', wanted.indexOf(id)])),
        );
      }
      await tx
        .update(teamRoster)
        .set({ validTo: now })
        .where(
          and(
            eq(teamRoster.teamId, team.id),
            isNull(teamRoster.validTo),
            inArray(teamRoster.membershipId, leaving),
          ),
        );
      if ((await join(tx, team, joining, now)).length > 0) {
        throw new ApiError(409, 'ALREADY_ON_TEAM', 'A player is already on a team this season');
      }

      const after = [...before.filter((id) => wanted.includes(id)), ...joining];
      await recordAudit(
        tx,
        actor,
        {
          action: 'team.roster_updated',
          targetType: 'team',
          targetId: team.id,
          actorWasParticipant: before.includes(actor.id) || after.includes(actor.id),
          details: { before, after },
        },
        now,
      );
      return loadTeam(tx, team.id);
    }),
  );
}
