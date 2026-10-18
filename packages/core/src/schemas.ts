import { z } from 'zod';

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
