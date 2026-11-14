import { DisplayName, formatSignInCode } from '@beer-die/core';
import { z } from 'zod';
import { open, seal } from '../crypto.ts';

// Subjects are fixed strings; user text never goes into headers. Bodies never carry stats
// or tokens.

export const SIGN_IN_CODE = 'sign_in_code';
export const DELETE_ACCOUNT_CODE = 'delete_account_code';
export const MEMBER_PENDING = 'member_pending';
export const GAME_REVISION = 'game_revision';
export const OVERRIDE_REQUESTED = 'override_requested';

const SignInCodeParams = z.strictObject({ code: z.string(), expiresAt: z.iso.datetime() });

export function signInCodeParams(key: Buffer, code: string, expiresAt: Date) {
  return { code: seal(key, code), expiresAt: expiresAt.toISOString() };
}

// Sent to commissioners. A display name and a link only: no email, no invite token.
const MemberPendingParams = z.strictObject({
  displayName: DisplayName,
  link: z.url({ protocol: /^https?$/ }),
});

export function memberPendingParams(displayName: string, link: string) {
  return { displayName, link };
}

// Sent to a game's other players when a revision opens. The author's name, what they did,
// and a link only: no scores, no game id.
const GameRevisionParams = z.strictObject({
  authorName: DisplayName,
  action: z.enum(['submitted', 'corrected']),
  link: z.url({ protocol: /^https?$/ }),
});

export function gameRevisionParams(
  authorName: string,
  action: 'submitted' | 'corrected',
  link: string,
) {
  return { authorName, action, link };
}

// Sent to commissioners when a revision that breaks the rules is sent for review. The
// author's name and a link only: no scores, no rule violations, no game id.
const OverrideRequestedParams = z.strictObject({
  authorName: DisplayName,
  link: z.url({ protocol: /^https?$/ }),
});

export function overrideRequestedParams(authorName: string, link: string) {
  return { authorName, link };
}

export type Rendered = { subject: string; text: string };
export type Render =
  Rendered | { drop: 'BAD_PARAMS' | 'EXPIRED' | 'UNREADABLE' | 'UNKNOWN_TEMPLATE' };

export function renderEmail(
  template: string,
  params: unknown,
  ctx: { key: Buffer; now: Date },
): Render {
  if (template === SIGN_IN_CODE) return renderSignInCode(params, ctx);
  if (template === DELETE_ACCOUNT_CODE) return renderDeleteAccountCode(params, ctx);
  if (template === MEMBER_PENDING) return renderMemberPending(params);
  if (template === GAME_REVISION) return renderGameRevision(params);
  if (template === OVERRIDE_REQUESTED) return renderOverrideRequested(params);
  return { drop: 'UNKNOWN_TEMPLATE' };
}

function renderGameRevision(params: unknown): Render {
  const parsed = GameRevisionParams.safeParse(params);
  if (!parsed.success) return { drop: 'BAD_PARAMS' };
  const { authorName, action, link } = parsed.data;
  return {
    subject:
      action === 'submitted'
        ? 'A new game is waiting for your confirmation'
        : 'A corrected game is waiting for your confirmation',
    text: [
      `${authorName} ${action} a game with you.`,
      '',
      `Check the result, then confirm it or propose a correction: ${link}`,
      '',
    ].join('\n'),
  };
}

function renderOverrideRequested(params: unknown): Render {
  const parsed = OverrideRequestedParams.safeParse(params);
  if (!parsed.success) return { drop: 'BAD_PARAMS' };
  return {
    subject: 'A game is waiting for commissioner review',
    text: [
      `${parsed.data.authorName} recorded a game that breaks the league rules and asked a commissioner to review it.`,
      '',
      `Review it: ${parsed.data.link}`,
      '',
    ].join('\n'),
  };
}

function renderMemberPending(params: unknown): Render {
  const parsed = MemberPendingParams.safeParse(params);
  if (!parsed.success) return { drop: 'BAD_PARAMS' };
  return {
    subject: 'A new member is awaiting approval',
    text: [
      `${parsed.data.displayName} asked to join your league and is waiting for approval.`,
      '',
      `Review pending members: ${parsed.data.link}`,
      '',
    ].join('\n'),
  };
}

// The mailed code of either kind (their params are the same), or why it can't be sent.
function mailedCode(
  params: unknown,
  ctx: { key: Buffer; now: Date },
): string | Exclude<Render, Rendered> {
  const parsed = SignInCodeParams.safeParse(params);
  if (!parsed.success) return { drop: 'BAD_PARAMS' };
  // A code the user can no longer redeem isn't worth sending.
  if (ctx.now.getTime() >= new Date(parsed.data.expiresAt).getTime()) return { drop: 'EXPIRED' };
  const code = open(ctx.key, parsed.data.code);
  return code === null ? { drop: 'UNREADABLE' } : code;
}

// Sent to a signed-in user who asked to delete their account. It says what the code does, so
// nobody enters or passes one on thinking it only signs them in.
function renderDeleteAccountCode(params: unknown, ctx: { key: Buffer; now: Date }): Render {
  const code = mailedCode(params, ctx);
  if (typeof code !== 'string') return code;
  return {
    subject: 'Your Beer Die League account deletion code',
    text: [
      `Your code to delete your Beer Die League account is ${formatSignInCode(code)}.`,
      '',
      'Entering it on the Account screen where you asked for it deletes your account for good.',
      'It expires in 10 minutes and works nowhere else.',
      '',
      "If you didn't ask to delete your account, don't enter this code or give it to anyone.",
      'Someone else may be signed in as you: open Account and choose "Sign out everywhere".',
      '',
    ].join('\n'),
  };
}

function renderSignInCode(params: unknown, ctx: { key: Buffer; now: Date }): Render {
  const code = mailedCode(params, ctx);
  if (typeof code !== 'string') return code;
  return {
    subject: 'Your Beer Die League sign-in code',
    text: [
      `Your sign-in code is ${formatSignInCode(code)}.`,
      '',
      'Enter it in the browser or app where you asked for it; it works nowhere else.',
      "It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.",
      '',
    ].join('\n'),
  };
}
