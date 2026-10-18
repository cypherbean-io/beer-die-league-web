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

export const MeResponse = z.strictObject({ user: User });
export type MeResponse = z.infer<typeof MeResponse>;
