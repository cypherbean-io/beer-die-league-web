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

const SideBody = z.strictObject({ players: z.array(PlayerLineBody).length(2) });

const PLAYED_AT_FLOOR = Date.parse('2000-01-01T00:00:00.000Z');

// The first submission of a game. The rest of checkStructure, the membership checks, and
// checkRules run on the server after this parses. `idempotencyKey` is generated once per
// draft, so a retried submission returns the original game.
export const SubmitGameBody = z.strictObject({
  idempotencyKey: z.uuid(),
  // Season games arrive with seasons (SPEC §3.10, slice 5).
  kind: z.literal('exhibition'),
  // The server refuses a time in the future. The floor keeps out years the database stores
  // but reads back wrong: a timestamp before year 100 comes back through `new Date()`, which
  // misparses it (0049 becomes 2049).
  playedAt: z.iso
    .datetime()
    .refine((s) => Date.parse(s) >= PLAYED_AT_FLOOR, 'Choose a time in or after 2000'),
  sides: z.strictObject({ A: SideBody, B: SideBody }),
  winner: GameSide,
  // Store a game that breaks the rules for a commissioner to review, instead of refusing it.
  requestOverride: z.boolean().optional(),
});
export type SubmitGameBody = z.input<typeof SubmitGameBody>;

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
  isSub: z.boolean(),
  // How the player confirmed this revision, or null while their confirmation is pending.
  confirmation: ConfirmationKind.nullable(),
});
export type GamePlayer = z.infer<typeof GamePlayer>;

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
});
export type GameRevision = z.infer<typeof GameRevision>;

export const Game = z.strictObject({
  id: z.uuid(),
  kind: GameKind,
  status: GameStatus,
  // The rules at first submission. Every revision of the game is checked against these.
  rulesSnapshot: LeagueRules,
  // Set at first submission and not moved by corrections. Null when nothing is open.
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
