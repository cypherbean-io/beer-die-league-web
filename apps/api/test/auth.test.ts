import { createHash } from 'node:crypto';
import { ErrorBody, MeResponse, VerifyCodeResponse } from '@beer-die/core';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase, resetTables } from './support/db.ts';
import { APP_ORIGIN, startApi, type TestApi } from './support/server.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CODE_TTL = 10 * MINUTE;

type SentMail = { to: Array<{ address: string }>; subject: string; text: string };

let database: Awaited<ReturnType<typeof freshDatabase>>;
let api: TestApi;
let clock: FixedClock;
let sent: SentMail[];

// Real nodemailer JSON transport; every message it renders is captured.
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
const capturingTransport: MailTransport = {
  async sendMail(message) {
    const info = await jsonTransport.sendMail(message);
    sent.push(JSON.parse(info.message) as SentMail);
    return info;
  },
};

beforeAll(async () => {
  database = await freshDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  clock = new FixedClock('2026-10-17T12:00:00.000Z');
  sent = [];
  api = await startApi(database.url, { clock });
  await resetTables(api.db);
});

afterEach(async () => {
  await api.stop();
});

type Opts = { origin?: string | null; cookie?: string; bearer?: string; contentType?: string };

function headersFor(opts: Opts): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/json',
  };
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return headers;
}

function post(path: string, body: unknown, opts: Opts = {}): Promise<Response> {
  return fetch(`${api.baseUrl}${path}`, {
    method: 'POST',
    headers: headersFor(opts),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getMe(opts: { cookie?: string; bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return fetch(`${api.baseUrl}/api/me`, { headers });
}

function drain(transport: MailTransport = capturingTransport) {
  return drainOutbox({
    db: api.db,
    clock,
    transport,
    mailFrom: 'Beer Die League <league@app.test>',
    authSecret: api.authSecret,
    log: (entry) => api.logs.push(entry),
  });
}

async function requestCode(email: string): Promise<void> {
  const res = await post('/api/auth/code', { email });
  expect(res.status).toBe(202);
}

function lastCodeMailedTo(email: string): string {
  const mail = sent.findLast((m) => m.to[0]?.address === email);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code was mailed to that address');
  return code;
}

async function mailedCode(email: string): Promise<string> {
  await requestCode(email);
  await drain();
  return lastCodeMailedTo(email);
}

function wrong(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

function verify(email: string, code: string, client: 'web' | 'native' = 'web', opts: Opts = {}) {
  return post('/api/auth/verify', { email, code, client }, opts);
}

function sessionSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('session='));
}

// Returns the `session=<token>` pair to send back as a Cookie header.
async function signInWeb(email: string): Promise<string> {
  const res = await verify(email, await mailedCode(email));
  expect(res.status).toBe(200);
  const cookie = sessionSetCookie(res);
  if (!cookie) throw new Error('no session cookie was set');
  return cookie.split(';')[0]!;
}

async function signInNative(email: string): Promise<string> {
  const res = await verify(email, await mailedCode(email), 'native', { origin: null });
  expect(res.status).toBe(200);
  const { token } = VerifyCodeResponse.parse(await res.json());
  if (!token) throw new Error('no token was returned');
  return token;
}

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

describe('POST /api/auth/code', () => {
  it('mails a 6-digit code to the requested address', async () => {
    await requestCode('ana@example.com');
    await drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to[0]!.address).toBe('ana@example.com');
    expect(sent[0]!.text).toMatch(/\b\d{6}\b/);
  });

  it('answers an unknown email with the same status and body as a known one', async () => {
    await signInWeb('known@example.com');

    const known = await post('/api/auth/code', { email: 'known@example.com' });
    const unknown = await post('/api/auth/code', { email: 'unknown@example.com' });

    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(await unknown.text()).toBe(await known.text());
  });

  it('stores the code in the outbox only in sealed form and wipes it after sending', async () => {
    await requestCode('ana@example.com');
    const [queued] = await api.db.execute<{ params: unknown }>(
      sql`select params from email_outbox`,
    );

    await drain();
    const code = lastCodeMailedTo('ana@example.com');
    const [afterSend] = await api.db.execute<{ params: unknown }>(
      sql`select params from email_outbox`,
    );

    expect(JSON.stringify(queued!.params)).not.toContain(code);
    expect(afterSend!.params).toEqual({});
  });

  it('does not mail a code that expired before the worker ran', async () => {
    await requestCode('ana@example.com');
    clock.advance(CODE_TTL);

    await drain();

    expect(sent).toHaveLength(0);
    const [row] = await api.db.execute<{ params: unknown; sent_at: Date | null }>(
      sql`select params, sent_at from email_outbox`,
    );
    expect(row).toMatchObject({ params: {}, sent_at: null });
  });

  it('retries a failed send after the backoff', async () => {
    const failing: MailTransport = {
      sendMail: () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNECTION' })),
    };
    await requestCode('ana@example.com');

    await drain(failing);
    const [failed] = await api.db.execute<{ attempts: number; last_error: string }>(
      sql`select attempts, last_error from email_outbox`,
    );
    await drain();
    const sentBeforeBackoff = sent.length;
    clock.advance(30 * SECOND);
    await drain();

    expect(failed).toEqual({ attempts: 1, last_error: 'ECONNECTION' });
    expect(sentBeforeBackoff).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('rate limits the 6th code request for one email within an hour', async () => {
    for (let i = 0; i < 5; i++) await requestCode('ana@example.com');

    const res = await post('/api/auth/code', { email: 'ana@example.com' });

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('allows code requests for that email again once the hour has passed', async () => {
    for (let i = 0; i < 5; i++) await requestCode('ana@example.com');
    clock.advance(HOUR);

    const res = await post('/api/auth/code', { email: 'ana@example.com' });

    expect(res.status).toBe(202);
  });

  it('rate limits the 21st code request from one IP within an hour', async () => {
    for (let i = 0; i < 20; i++) await requestCode(`player${i}@example.com`);

    const res = await post('/api/auth/code', { email: 'player20@example.com' });

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('rejects unknown fields with 422 VALIDATION', async () => {
    const res = await post('/api/auth/code', { email: 'ana@example.com', admin: true });

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
  });

  it('rejects a body over 16 KB with 413', async () => {
    const res = await post('/api/auth/code', { email: 'ana@example.com', pad: 'x'.repeat(17_000) });

    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a write that is not JSON with 415', async () => {
    const res = await post('/api/auth/code', 'email=ana@example.com', {
      contentType: 'application/x-www-form-urlencoded',
    });

    expect(res.status).toBe(415);
  });
});

describe('POST /api/auth/verify', () => {
  it('creates a session for the correct code and stores only the token hash', async () => {
    const code = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(200);
    const body = VerifyCodeResponse.parse(await res.json());
    expect(body.user.email).toBe('ana@example.com');
    expect(body.token).toBeUndefined();
    const token = sessionSetCookie(res)!.split(';')[0]!.slice('session='.length);
    const rows = await api.db.execute<{ token_sha256: string }>(
      sql`select token_sha256 from sessions`,
    );
    expect(rows.map((r) => r.token_sha256)).toEqual([
      createHash('sha256').update(token).digest('hex'),
    ]);
  });

  it('treats the email case-insensitively', async () => {
    const code = await mailedCode('ana@example.com');

    const res = await verify('Ana@Example.COM', code);

    expect(res.status).toBe(200);
  });

  it('sets the web session cookie HttpOnly, Secure, and SameSite=Lax on /api', async () => {
    const res = await verify('ana@example.com', await mailedCode('ana@example.com'));

    const cookie = sessionSetCookie(res)!;
    expect(cookie).toMatch(/;\s*HttpOnly(;|$)/i);
    expect(cookie).toMatch(/;\s*Secure(;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax(;|$)/i);
    expect(cookie).toMatch(/;\s*Path=\/api(;|$)/);
  });

  it('returns a bearer token, and no cookie, for a native client', async () => {
    const res = await verify('ana@example.com', await mailedCode('ana@example.com'), 'native', {
      origin: null,
    });

    expect(res.status).toBe(200);
    expect(VerifyCodeResponse.parse(await res.json()).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('rejects a wrong code with 401 INVALID_CODE', async () => {
    const code = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', wrong(code));

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('INVALID_CODE');
  });

  it('still accepts the correct code after four wrong attempts', async () => {
    const code = await mailedCode('ana@example.com');
    for (let i = 0; i < 4; i++) await verify('ana@example.com', wrong(code));

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(200);
  });

  it('invalidates the code on the 5th wrong attempt', async () => {
    const code = await mailedCode('ana@example.com');
    for (let i = 0; i < 5; i++) await verify('ana@example.com', wrong(code));

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(401);
  });

  it('evaluates at most 5 guesses from a concurrent burst', async () => {
    const code = await mailedCode('ana@example.com');

    await Promise.all(Array.from({ length: 10 }, () => verify('ana@example.com', wrong(code))));

    // Every evaluated guess increments `attempts`; guesses past the cap are refused unseen.
    const [row] = await api.db.execute<{ attempts: number }>(sql`select attempts from auth_codes`);
    expect(row!.attempts).toBe(5);
  });

  it('accepts a code 1 s before its TTL', async () => {
    const code = await mailedCode('ana@example.com');
    clock.advance(CODE_TTL - SECOND);

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(200);
  });

  it('rejects a code at TTL + 1 s', async () => {
    const code = await mailedCode('ana@example.com');
    clock.advance(CODE_TTL + SECOND);

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(401);
  });

  it('rejects a code that was already used', async () => {
    const code = await mailedCode('ana@example.com');
    await verify('ana@example.com', code);

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(401);
  });

  it('rate limits the 21st verify attempt for one email within a day, across codes', async () => {
    for (let i = 0; i < 20; i++) await verify('ana@example.com', '000000');
    const code = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('allows verify attempts for that email again once the day has passed', async () => {
    for (let i = 0; i < 20; i++) await verify('ana@example.com', '000000');
    clock.advance(DAY);
    const code = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', code);

    expect(res.status).toBe(200);
  });

  it('rate limits the 61st verify attempt from one IP within an hour', async () => {
    for (let i = 0; i < 60; i++) await verify(`player${i}@example.com`, '000000');

    const res = await verify('player60@example.com', '000000');

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('invalidates the previous code when a new one is requested', async () => {
    const first = await mailedCode('ana@example.com');
    let second = await mailedCode('ana@example.com');
    // Two random codes collide one time in a million; request again rather than flake.
    while (second === first) second = await mailedCode('ana@example.com');

    const stale = await verify('ana@example.com', first);
    const fresh = await verify('ana@example.com', second);

    expect(stale.status).toBe(401);
    expect(fresh.status).toBe(200);
  });
});

describe('sessions', () => {
  it('rejects GET /api/me without a session', async () => {
    const res = await getMe();

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('resolves the signed-in user from the web cookie', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await getMe({ cookie });

    expect(res.status).toBe(200);
    expect(MeResponse.parse(await res.json()).user.email).toBe('ana@example.com');
  });

  it('accepts a bearer token from a native sign-in', async () => {
    const token = await signInNative('ana@example.com');

    const res = await getMe({ bearer: token });

    expect(res.status).toBe(200);
    expect(MeResponse.parse(await res.json()).user.email).toBe('ana@example.com');
  });

  it('rejects a web session token sent as a bearer token', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await getMe({ bearer: cookie.slice('session='.length) });

    expect(res.status).toBe(401);
  });

  it('expires a session 30 days after its last use', async () => {
    const cookie = await signInWeb('ana@example.com');
    clock.advance(30 * DAY);

    const res = await getMe({ cookie });

    expect(res.status).toBe(401);
  });

  it('keeps a session in use alive past 30 days from sign-in', async () => {
    const cookie = await signInWeb('ana@example.com');
    clock.advance(20 * DAY);
    await getMe({ cookie });
    clock.advance(20 * DAY);

    const res = await getMe({ cookie });

    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout', {}, { cookie });

    expect(res.status).toBe(204);
    expect(sessionSetCookie(res)).toMatch(/Max-Age=0/);
    expect((await getMe({ cookie })).status).toBe(401);
  });

  it('revokes a native session presented as a bearer token without an Origin', async () => {
    const token = await signInNative('ana@example.com');

    const res = await post('/api/auth/logout', {}, { bearer: token, origin: null });

    expect(res.status).toBe(204);
    expect((await getMe({ bearer: token })).status).toBe(401);
  });

  it('rejects a cookie-authenticated write from a foreign Origin with 403', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout', {}, { cookie, origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect((await getMe({ cookie })).status).toBe(200);
  });

  it('rejects a cookie-authenticated write with no Origin with 403', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout', {}, { cookie, origin: null });

    expect(res.status).toBe(403);
    expect((await getMe({ cookie })).status).toBe(200);
  });
});

describe('auth logging', () => {
  it('logs route templates but never the email, code, or token', async () => {
    const email = 'ana@example.com';
    const code = await mailedCode(email);
    await verify(email, wrong(code));
    const res = await verify(email, code);
    const cookie = sessionSetCookie(res)!.split(';')[0]!;
    await getMe({ cookie });
    await post('/api/auth/logout', {}, { cookie });
    const token = await signInNative('bo@example.com');
    await getMe({ bearer: token });

    const logged = JSON.stringify(api.logs);
    expect(api.logs).toContainEqual(expect.objectContaining({ route: '/api/auth/verify' }));
    for (const secret of [email, 'bo@example.com', code, cookie.slice(8), token]) {
      expect(logged).not.toContain(secret);
    }
  });
});
