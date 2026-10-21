import { z } from 'zod';
import type { PlayerLine, RuleViolation } from './rules.ts';

export const ErrorBody = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HealthResponse = z.strictObject({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// Emails are compared case-insensitively, so the API sees them lowercased.
export const Email = z
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());

export const SignInCode = z.string().regex(/^[0-9]{6}$/, 'Expected a 6-digit code');

export const SessionClient = z.enum(['web', 'native']);
export type SessionClient = z.infer<typeof SessionClient>;

export const RequestCodeBody = z.strictObject({ email: Email });
export type RequestCodeBody = z.input<typeof RequestCodeBody>;

export const VerifyCodeBody = z.strictObject({
  email: Email,
  code: SignInCode,
  client: SessionClient,
});
export type VerifyCodeBody = z.input<typeof VerifyCodeBody>;

export const User = z.strictObject({ id: z.uuid(), email: z.string() });
export type User = z.infer<typeof User>;

// `token` is present only for `client: 'native'`; web sessions get an httpOnly cookie.
export const VerifyCodeResponse = z.strictObject({ user: User, token: z.string().optional() });
export type VerifyCodeResponse = z.infer<typeof VerifyCodeResponse>;

// NFKC, so lookalike compatibility forms ("Ａｎａ") collapse to one spelling. Typographic
// apostrophes become plain ones, because phone keyboards insert them in names like O'Neil.
export function normalizeDisplayName(raw: string): string {
  return raw.normalize('NFKC').replace(/[‘’]/g, "'").trim().replace(/ {2,}/g, ' ');
}

// The uniqueness key within a league. Derived by the server, never sent by a client.
export function nameKey(displayName: string): string {
  return displayName.normalize('NFKC').toLowerCase();
}

// The scripts whose letters are most easily confused with each other ("Аnа" vs "Ana").
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Greek}/u, /\p{Script=Cyrillic}/u];

// 2–24 characters of letters (with their combining marks), digits, space, and -_.'
// Names identify people in game records, so the rules also refuse names that could pass
// for another member's: invisible characters, a leading mark, or Latin, Greek, and Cyrillic
// letters mixed together. A name also can't look like a domain, because mail clients turn
// one into a link and display names appear in league email.
export const DisplayName = z
  .string()
  .max(100)
  .transform(normalizeDisplayName)
  .pipe(
    z
      .string()
      .refine((name) => {
        const length = [...name].length;
        return length >= 2 && length <= 24;
      }, 'Use 2 to 24 characters')
      .regex(/^[\p{L}\p{M}\p{Nd} '._-]+$/u, "Use only letters, digits, spaces, and - _ . '")
      .regex(/^[\p{L}\p{Nd}]/u, 'Start with a letter or digit')
      .refine(
        (name) => !/\p{Default_Ignorable_Code_Point}/u.test(name),
        'Remove invisible characters',
      )
      .refine(
        (name) => CONFUSABLE_SCRIPTS.filter((script) => script.test(name)).length <= 1,
        'Use letters from one alphabet',
      )
      .refine((name) => !/\.[\p{L}\p{Nd}]{2,}/u.test(name), 'Don’t use a web address'),
  );

export const LeagueName = z
  .string()
  .transform((name) => name.normalize('NFKC').trim())
  .pipe(z.string().min(1).max(60));

export const MembershipRole = z.enum(['member', 'commissioner']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const MembershipStatus = z.enum(['pending', 'approved', 'removed', 'left', 'deleted']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

// The caller's own membership, as listed on /me.
export const MyMembership = z.strictObject({
  id: z.uuid(),
  leagueId: z.uuid(),
  leagueName: z.string(),
  displayName: z.string(),
  role: MembershipRole,
  status: MembershipStatus,
});
export type MyMembership = z.infer<typeof MyMembership>;

export const MeResponse = z.strictObject({ user: User, memberships: z.array(MyMembership) });
export type MeResponse = z.infer<typeof MeResponse>;

export const LeagueRules = z.strictObject({
  targetScore: z.int(),
  winBy: z.int(),
  sinkPoints: z.int(),
  sinkEndsGame: z.boolean(),
});

export const League = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  rules: LeagueRules,
  confirmationWindowDays: z.int(),
  exhibitionCorrectionWindowDays: z.int(),
});
export type League = z.infer<typeof League>;

export const LeagueResponse = z.strictObject({ league: League });
export type LeagueResponse = z.infer<typeof LeagueResponse>;

const atLeastOneKey = (patch: object) => Object.keys(patch).length > 0;

// A partial update. The upper bounds match the 0–99 range of a player's points, and keep a
// typo from producing rules no game could satisfy.
export const RulesBody = z
  .strictObject({
    targetScore: z.int().min(1).max(99).optional(),
    winBy: z.int().min(1).max(99).optional(),
    sinkPoints: z.int().min(0).max(99).optional(),
    sinkEndsGame: z.boolean().optional(),
  })
  .refine(atLeastOneKey, 'Change at least one rule');
export type RulesBody = z.input<typeof RulesBody>;

export const LeagueSettings = z.strictObject({
  confirmationWindowDays: z.int(),
  exhibitionCorrectionWindowDays: z.int(),
});
export type LeagueSettings = z.infer<typeof LeagueSettings>;

// A partial update, with the same ranges as the database's check constraints.
export const SettingsBody = z
  .strictObject({
    confirmationWindowDays: z.int().min(1).max(30).optional(),
    exhibitionCorrectionWindowDays: z.int().min(0).max(365).optional(),
  })
  .refine(atLeastOneKey, 'Change at least one setting');
export type SettingsBody = z.input<typeof SettingsBody>;

// One line of 1 to `max` visible characters, NFKC-normalized like a league name, with runs of
// spaces collapsed. Every member sees season and team names, so like display names they can't
// hold line breaks, direction overrides, or invisible characters that would disguise them.
const oneLineName = (max: number) =>
  z
    .string()
    .max(200)
    .transform((name) => name.normalize('NFKC').trim().replace(/ {2,}/g, ' '))
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, 'Use a single line of text')
        .refine(
          (name) => !/\p{Default_Ignorable_Code_Point}/u.test(name),
          'Remove invisible characters',
        ),
    );

export const SeasonName = oneLineName(60);

export const CreateSeasonBody = z.strictObject({ name: SeasonName });
export type CreateSeasonBody = z.input<typeof CreateSeasonBody>;

// SPEC §3.7: draft → active (a commissioner starts it; one active season per league) → ended
// (a commissioner ends it) → finalized (automatically, once none of its games has an open
// revision). Finalization locks the season's standings config.
export const SeasonStatus = z.enum(['draft', 'active', 'ended', 'finalized']);
export type SeasonStatus = z.infer<typeof SeasonStatus>;

// What season standings rank teams by, in order; each later metric breaks ties left by the
// ones before it.
export const StandingsMetric = z.enum([
  'win_pct',
  'wins',
  'point_diff',
  'points_for',
  'sinks',
  'head_to_head',
]);
export type StandingsMetric = z.infer<typeof StandingsMetric>;

const StandingsOrder = z
  .array(StandingsMetric)
  .min(1)
  .max(StandingsMetric.options.length)
  .refine((order) => new Set(order).size === order.length, 'List each metric once');

// Teams with fewer games than this are listed but unranked. A team with no games always is.
const MinGames = z.int().min(0).max(99);

export const StandingsConfig = z.strictObject({ order: StandingsOrder, minGames: MinGames });
export type StandingsConfig = z.infer<typeof StandingsConfig>;

export const DEFAULT_STANDINGS_CONFIG: StandingsConfig = {
  order: ['win_pct', 'head_to_head', 'point_diff', 'sinks'],
  minGames: 0,
};

// A partial update; `order` replaces the whole order.
export const StandingsConfigBody = z
  .strictObject({ order: StandingsOrder.optional(), minGames: MinGames.optional() })
  .refine(atLeastOneKey, 'Change the order or the minimum games');
export type StandingsConfigBody = z.input<typeof StandingsConfigBody>;

export const Season = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: SeasonStatus,
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  finalizedAt: z.iso.datetime().nullable(),
  standingsConfig: StandingsConfig,
});
export type Season = z.infer<typeof Season>;

export const SeasonResponse = z.strictObject({ season: Season });
export type SeasonResponse = z.infer<typeof SeasonResponse>;

// Newest first.
export const SeasonsResponse = z.strictObject({ seasons: z.array(Season) });
export type SeasonsResponse = z.infer<typeof SeasonsResponse>;

// Unique, ignoring case, among a season's teams that haven't been rejected or withdrawn.
// Members pick opponents by team name, so like a display name it can't mix lookalike alphabets
// to pass for another team's.
export const TeamName = oneLineName(40).refine(
  (name) => CONFUSABLE_SCRIPTS.filter((script) => script.test(name)).length <= 1,
  'Use letters from one alphabet',
);

// A member proposes a team with a partner, who then accepts.
export const ProposeTeamBody = z.strictObject({ name: TeamName, partnerId: z.uuid() });
export type ProposeTeamBody = z.input<typeof ProposeTeamBody>;

// An approved team's new roster: two different approved members.
export const RosterBody = z.strictObject({
  membershipIds: z
    .array(z.uuid())
    .length(2)
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      'List two different players',
    ),
});
export type RosterBody = z.input<typeof RosterBody>;

// SPEC §3.7: a member proposes a team with a partner (proposed), the partner accepts
// (accepted), and a commissioner approves it (approved). Until then either player can withdraw
// it, and a commissioner can reject it. Only an approved team plays season games.
export const TeamStatus = z.enum(['proposed', 'accepted', 'approved', 'rejected', 'withdrawn']);
export type TeamStatus = z.infer<typeof TeamStatus>;

const TeamPlayer = z.strictObject({ membershipId: z.uuid(), displayName: z.string() });

export const Team = z.strictObject({
  id: z.uuid(),
  seasonId: z.uuid(),
  name: z.string(),
  status: TeamStatus,
  proposedBy: z.uuid(),
  // The current roster. A rejected or withdrawn team lists the pair it was proposed with.
  players: z.array(TeamPlayer),
  createdAt: z.iso.datetime(),
});
export type Team = z.infer<typeof Team>;

export const TeamResponse = z.strictObject({ team: Team });
export type TeamResponse = z.infer<typeof TeamResponse>;

// By name.
export const TeamsResponse = z.strictObject({ teams: z.array(Team) });
export type TeamsResponse = z.infer<typeof TeamsResponse>;

// One approved team's line in its season's standings (SPEC §3.7), from confirmed games only.
// Points for and against are each side's players' points, sink points and subs included.
// Teams tied on every metric of the season's order share a rank and are marked tied (shown as
// "T-2"). A team below the season's minimum games, or with none, has no rank.
export const StandingsRow = z.strictObject({
  team: z.strictObject({ id: z.uuid(), name: z.string() }),
  rank: z.int().min(1).nullable(),
  tied: z.boolean(),
  gamesPlayed: z.int(),
  wins: z.int(),
  losses: z.int(),
  winPct: z.number().nullable(),
  pointsFor: z.int(),
  pointsAgainst: z.int(),
  pointDiff: z.int(),
  sinks: z.int(),
});
export type StandingsRow = z.infer<typeof StandingsRow>;

// Ranked teams by rank, ties by name, then unranked teams by name. The season carries the
// config they were ranked by.
export const StandingsResponse = z.strictObject({
  season: Season,
  standings: z.array(StandingsRow),
});
export type StandingsResponse = z.infer<typeof StandingsResponse>;

export const AUDIT_PAGE_MAX = 100;

// Query strings arrive as strings. Only plain digits count as a limit, so "1e2" and " 5"
// are rejected rather than coerced.
export const AuditQuery = z.strictObject({
  before: z.uuid().optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, 'Expected a whole number')
    .transform(Number)
    .pipe(z.int().min(1).max(AUDIT_PAGE_MAX))
    .optional(),
});
export type AuditQuery = z.input<typeof AuditQuery>;

const auditEventFields = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  actor: z.strictObject({ membershipId: z.uuid(), displayName: z.string() }),
  // Set when a commissioner acted on a game they played in.
  actorWasParticipant: z.boolean(),
  targetId: z.uuid(),
};

// What the log stores when a commissioner confirms a revision for a silent player.
export const ForcedConfirmationDetails = z.strictObject({
  revisionId: z.uuid(),
  membershipId: z.uuid(),
});

// A commissioner's decision on a rule-breaking revision sent for review. Approving lets it
// confirm once all four players have; rejecting means it never counts.
export const OverrideDecision = z.enum(['approve', 'reject']);

// What the log stores when a commissioner decides a review.
const OverrideDecidedDetails = z.strictObject({
  revisionId: z.uuid(),
  decision: OverrideDecision,
});

// The season an entry is about, named when the log is read rather than stored in `details`.
const AuditSeason = z.strictObject({ id: z.uuid(), name: z.string() });

// Likewise the team an entry is about, and the players it names.
const AuditTeam = z.strictObject({ id: z.uuid(), name: z.string() });
const AuditPlayer = z.strictObject({ membershipId: z.uuid(), displayName: z.string() });

// What the log stores when a commissioner changes an approved team's roster: its players'
// ids before and after, in roster order.
export const RosterChangeDetails = z.strictObject({
  before: z.array(z.uuid()),
  after: z.array(z.uuid()),
});

// What the log stores when a commissioner rejects a team: its status then. Only its pair and
// the commissioners ever saw a team rejected as a proposal, so only they see its name here.
export const TeamRejectedDetails = z.strictObject({ status: z.enum(['proposed', 'accepted']) });

// One entry in the league's append-only log of commissioner actions. Each action has its
// own `details` shape, which never holds names, emails, or tokens.
export const AuditEvent = z.discriminatedUnion('action', [
  z.strictObject({
    ...auditEventFields,
    action: z.literal('league.rules_updated'),
    targetType: z.literal('league'),
    details: z.strictObject({ before: LeagueRules, after: LeagueRules }),
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('league.settings_updated'),
    targetType: z.literal('league'),
    details: z.strictObject({ before: LeagueSettings, after: LeagueSettings }),
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('game.confirmation_forced'),
    targetType: z.literal('game'),
    details: ForcedConfirmationDetails,
    // The player confirmed for, named when the log is read rather than stored in `details`.
    player: AuditPlayer,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('game.override_decided'),
    targetType: z.literal('game'),
    details: OverrideDecidedDetails,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('season.started'),
    targetType: z.literal('season'),
    details: z.strictObject({}),
    season: AuditSeason,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('season.ended'),
    targetType: z.literal('season'),
    details: z.strictObject({}),
    season: AuditSeason,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('season.standings_config_updated'),
    targetType: z.literal('season'),
    details: z.strictObject({ before: StandingsConfig, after: StandingsConfig }),
    season: AuditSeason,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('team.approved'),
    targetType: z.literal('team'),
    details: z.strictObject({}),
    team: AuditTeam,
    season: AuditSeason,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('team.rejected'),
    targetType: z.literal('team'),
    details: TeamRejectedDetails,
    // Null for a rejected proposal, unless the reader is one of its pair or a commissioner.
    team: AuditTeam.nullable(),
    season: AuditSeason,
  }),
  z.strictObject({
    ...auditEventFields,
    action: z.literal('team.roster_updated'),
    targetType: z.literal('team'),
    details: RosterChangeDetails,
    team: AuditTeam,
    season: AuditSeason,
    roster: z.strictObject({ before: z.array(AuditPlayer), after: z.array(AuditPlayer) }),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEvent>;

// Newest first. `nextBefore` is the `before` cursor for the next page, or null at the end.
export const AuditResponse = z.strictObject({
  events: z.array(AuditEvent),
  nextBefore: z.uuid().nullable(),
});
export type AuditResponse = z.infer<typeof AuditResponse>;

// `email` is present only on pending members, and only when a commissioner is asking.
export const Member = z.strictObject({
  id: z.uuid(),
  displayName: z.string(),
  role: MembershipRole,
  status: MembershipStatus,
  email: z.string().optional(),
});
export type Member = z.infer<typeof Member>;

export const MembersResponse = z.strictObject({ members: z.array(Member) });
export type MembersResponse = z.infer<typeof MembersResponse>;

export const MemberResponse = z.strictObject({ member: Member });
export type MemberResponse = z.infer<typeof MemberResponse>;

export const RoleBody = z.strictObject({ role: MembershipRole });
export type RoleBody = z.input<typeof RoleBody>;

export const EmptyBody = z.strictObject({});

export const JoinBody = z.strictObject({ displayName: DisplayName });
export type JoinBody = z.input<typeof JoinBody>;

export const JoinResponse = z.strictObject({ membership: MyMembership });
export type JoinResponse = z.infer<typeof JoinResponse>;

// An invite as listed to commissioners. The token is shown only once, in the create response.
export const Invite = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof Invite>;

export const CreateInviteResponse = z.strictObject({ invite: Invite, url: z.url() });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

export const InvitesResponse = z.strictObject({ invites: z.array(Invite) });
export type InvitesResponse = z.infer<typeof InvitesResponse>;

export const GameSide = z.enum(['A', 'B']);

export const GameKind = z.enum(['season', 'exhibition']);
export type GameKind = z.infer<typeof GameKind>;

// A game's points (sink points included) or sinks for one player.
const LineValue = z.int().min(0).max(99);

// What a client sends for one player. `is_sub` and team totals are derived by the server,
// so they aren't accepted.
const PlayerLineBody = z.strictObject({
  membershipId: z.uuid(),
  points: LineValue,
  sinks: LineValue,
});

const players = z.array(PlayerLineBody).length(2);

const SideBody = z.strictObject({ players });

// A season game's side names the team it played for. The server checks the players against
// that team's roster and derives which of them is a sub.
const SeasonSideBody = z.strictObject({ teamId: z.uuid(), players });

const PLAYED_AT_FLOOR = Date.parse('2000-01-01T00:00:00.000Z');

// The result every revision of a game records. The rest of checkStructure, the membership
// checks, and checkRules run on the server after this parses.
const resultFields = {
  // The server refuses a time in the future. The floor keeps out years the database stores
  // but reads back wrong: a timestamp before year 100 comes back through `new Date()`, which
  // misparses it (0049 becomes 2049).
  playedAt: z.iso
    .datetime()
    .refine((s) => Date.parse(s) >= PLAYED_AT_FLOOR, 'Choose a time in or after 2000'),
  sides: z.strictObject({ A: SideBody, B: SideBody }),
  winner: GameSide,
  // Store a result that breaks the rules for a commissioner to review, instead of refusing it.
  requestOverride: z.boolean().optional(),
};

// The first submission of an exhibition game: any four approved members.
export const ExhibitionGameBody = z.strictObject({
  idempotencyKey: z.uuid(),
  kind: z.literal('exhibition'),
  ...resultFields,
});
export type ExhibitionGameBody = z.input<typeof ExhibitionGameBody>;

// The first submission of a season game (SPEC §3.7): two approved teams of the active season,
// each side its team's roster with at most one sub.
export const SeasonGameBody = z.strictObject({
  idempotencyKey: z.uuid(),
  kind: z.literal('season'),
  seasonId: z.uuid(),
  ...resultFields,
  sides: z.strictObject({ A: SeasonSideBody, B: SeasonSideBody }),
});
export type SeasonGameBody = z.input<typeof SeasonGameBody>;

// The first submission of a game. `idempotencyKey` is generated once per draft, so a
// retried submission returns the original game.
export const SubmitGameBody = z.discriminatedUnion('kind', [ExhibitionGameBody, SeasonGameBody]);
export type SubmitGameBody = z.input<typeof SubmitGameBody>;

// A corrected result, which becomes the game's new open revision. The game keeps its kind.
// `baseRevisionId` is the revision the author was shown: the open one, or, for a confirmed
// game with nothing open, the confirmed one, which reopens the game. If the game has moved on
// since, the correction is refused, so nobody overwrites numbers they haven't seen. A season
// game also keeps its teams, which follow their players from the base revision, so a
// correction names no teams.
export const CorrectGameBody = z.strictObject({
  baseRevisionId: z.uuid(),
  ...resultFields,
});
export type CorrectGameBody = z.input<typeof CorrectGameBody>;

// The players a commissioner confirms an open revision for, because they have stayed silent.
// A listed player who has already confirmed is skipped. A game has four players, each listed
// at most once.
export const ForceConfirmBody = z.strictObject({
  membershipIds: z
    .array(z.uuid())
    .min(1)
    .max(4)
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      'List each player once',
    ),
});
export type ForceConfirmBody = z.input<typeof ForceConfirmBody>;

// A commissioner's decision on a rule-breaking revision sent for review.
export const OverrideDecisionBody = z.strictObject({ decision: OverrideDecision });
export type OverrideDecisionBody = z.input<typeof OverrideDecisionBody>;

type SideLines = { players: Array<Omit<PlayerLine, 'side'>> };

// A submission's sides as the flat player list checkStructure and checkRules take: side A's
// players, then side B's.
export function playerLines(sides: { A: SideLines; B: SideLines }): PlayerLine[] {
  return (['A', 'B'] as const).flatMap((side) => sides[side].players.map((p) => ({ ...p, side })));
}

export const GameStatus = z.enum(['pending', 'confirmed', 'expired', 'voided']);
export const RevisionStatus = z.enum([
  'open',
  'confirmed',
  'superseded',
  'expired',
  'voided',
  'rejected',
]);
export const OverrideStatus = z.enum(['requested', 'approved', 'rejected']);
export const ConfirmationKind = z.enum(['player', 'forced']);

export const GameRuleViolation = z.strictObject({
  code: z.enum([
    'BELOW_TARGET',
    'MARGIN_TOO_SMALL',
    'ALREADY_OVER',
    'LOSER_SINK_WHEN_SINK_ENDS',
    'MULTIPLE_SINKS_WHEN_SINK_ENDS',
    'SINK_AFTER_GAME_OVER',
  ]),
  message: z.string(),
}) satisfies z.ZodType<RuleViolation>;

export const GamePlayer = z.strictObject({
  membershipId: z.uuid(),
  displayName: z.string(),
  side: GameSide,
  points: z.int(),
  sinks: z.int(),
  // Derived by the server: in a season game, a player who wasn't on their side's team.
  isSub: z.boolean(),
  // How the player confirmed this revision, or null while their confirmation is pending.
  confirmation: ConfirmationKind.nullable(),
});
export type GamePlayer = z.infer<typeof GamePlayer>;

const GameTeam = z.strictObject({ id: z.uuid(), name: z.string() });

// Revisions are immutable; a correction creates a new one.
export const GameRevision = z.strictObject({
  id: z.uuid(),
  number: z.int(),
  status: RevisionStatus,
  createdBy: z.uuid(),
  playedAt: z.iso.datetime(),
  winner: GameSide,
  // Side A's players, then side B's.
  players: z.array(GamePlayer),
  // Empty when the revision conforms to the game's rules snapshot.
  ruleViolations: z.array(GameRuleViolation),
  overrideStatus: OverrideStatus.nullable(),
  // The team each side played for in a season game; null for an exhibition game. Only an
  // approved team plays one, so every member may see its name.
  teams: z.strictObject({ A: GameTeam, B: GameTeam }).nullable(),
});
export type GameRevision = z.infer<typeof GameRevision>;

export const Game = z.strictObject({
  id: z.uuid(),
  kind: GameKind,
  // Set exactly when the game is a season game.
  seasonId: z.uuid().nullable(),
  status: GameStatus,
  // The rules at first submission. Every revision of the game is checked against these.
  rulesSnapshot: LeagueRules,
  // Set at first submission, or when a confirmed game is reopened, and not moved by
  // corrections. Null when nothing is open.
  windowExpiresAt: z.iso.datetime().nullable(),
  // The revision awaiting confirmation, if any.
  openRevision: GameRevision.nullable(),
  // The revision that counts in stats, once all four players have confirmed one.
  confirmedRevision: GameRevision.nullable(),
});
export type Game = z.infer<typeof Game>;

export const GameResponse = z.strictObject({ game: Game });
export type GameResponse = z.infer<typeof GameResponse>;

// The inbox lists at most this many games. Normal play never comes close; the cap keeps a
// flood of submissions from making a player's inbox unloadable.
export const INBOX_MAX = 50;

// Games whose open revision awaits the caller's confirmation, soonest to expire first.
export const InboxResponse = z.strictObject({ games: z.array(Game).max(INBOX_MAX) });
export type InboxResponse = z.infer<typeof InboxResponse>;

// Which counted games a stat covers (SPEC §3.7): `alltime` is every season game, and
// `combined` is every game. Season scopes (`season:<id>`) arrive with seasons (slice 5).
export const StatsScope = z.enum(['alltime', 'exhibition', 'combined']);
export type StatsScope = z.infer<typeof StatsScope>;

export const PlayerStatsQuery = z.strictObject({ scope: StatsScope });
export type PlayerStatsQuery = z.input<typeof PlayerStatsQuery>;

// One player's line in a scope, from confirmed games only. Points include sink points. The
// per-game rates are null until the player has a counted game in the scope.
export const PlayerStats = z.strictObject({
  membershipId: z.uuid(),
  displayName: z.string(),
  gamesPlayed: z.int(),
  wins: z.int(),
  losses: z.int(),
  winPct: z.number().nullable(),
  points: z.int(),
  pointsPerGame: z.number().nullable(),
  sinks: z.int(),
  sinksPerGame: z.number().nullable(),
});
export type PlayerStats = z.infer<typeof PlayerStats>;

// Every player with a counted game in the scope, by wins, then points, then name.
export const PlayerStatsResponse = z.strictObject({ players: z.array(PlayerStats) });
export type PlayerStatsResponse = z.infer<typeof PlayerStatsResponse>;

export const PlayerStatResponse = z.strictObject({ player: PlayerStats });
export type PlayerStatResponse = z.infer<typeof PlayerStatResponse>;

export const PartnershipStatsQuery = z.strictObject({ scope: StatsScope });
export type PartnershipStatsQuery = z.input<typeof PartnershipStatsQuery>;

const Partner = z.strictObject({ membershipId: z.uuid(), displayName: z.string() });

// Two players' line in a scope from the confirmed games they played on the same side, subs
// included (SPEC §3.7). Points (sink points included) and sinks are the pair's combined
// totals. The players are in pairKey order.
export const PartnershipStats = z.strictObject({
  players: z.tuple([Partner, Partner]),
  gamesPlayed: z.int(),
  wins: z.int(),
  losses: z.int(),
  winPct: z.number(),
  points: z.int(),
  sinks: z.int(),
});
export type PartnershipStats = z.infer<typeof PartnershipStats>;

// Every pair with a counted game in the scope, by wins, then points, then names.
export const PartnershipStatsResponse = z.strictObject({
  partnerships: z.array(PartnershipStats),
});
export type PartnershipStatsResponse = z.infer<typeof PartnershipStatsResponse>;
