import { z } from 'zod';
import { open, seal } from '../crypto.ts';

// Subjects are fixed strings; user text never goes into headers. Bodies never carry stats
// or tokens.

export const SIGN_IN_CODE = 'sign_in_code';

// Templates whose params hold a sealed secret; the outbox wipes their params once a row is
// terminal.
export const SENSITIVE_TEMPLATES: ReadonlySet<string> = new Set([SIGN_IN_CODE]);

const SignInCodeParams = z.strictObject({ code: z.string(), expiresAt: z.iso.datetime() });

export function signInCodeParams(key: Buffer, code: string, expiresAt: Date) {
  return { code: seal(key, code), expiresAt: expiresAt.toISOString() };
}

export type Rendered = { subject: string; text: string };
export type Render =
  Rendered | { drop: 'BAD_PARAMS' | 'EXPIRED' | 'UNREADABLE' | 'UNKNOWN_TEMPLATE' };

export function renderEmail(
  template: string,
  params: unknown,
  ctx: { key: Buffer; now: Date },
): Render {
  if (template !== SIGN_IN_CODE) return { drop: 'UNKNOWN_TEMPLATE' };
  const parsed = SignInCodeParams.safeParse(params);
  if (!parsed.success) return { drop: 'BAD_PARAMS' };
  // A code the user can no longer redeem isn't worth sending.
  if (ctx.now.getTime() >= new Date(parsed.data.expiresAt).getTime()) return { drop: 'EXPIRED' };
  const code = open(ctx.key, parsed.data.code);
  if (code === null) return { drop: 'UNREADABLE' };
  return {
    subject: 'Your Beer Die League sign-in code',
    text: [
      `Your sign-in code is ${code}.`,
      '',
      "It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.",
      '',
    ].join('\n'),
  };
}
