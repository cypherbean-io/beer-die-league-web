import { createHash, randomBytes } from 'node:crypto';
import { ErrorBody, MeResponse, RequestCodeResponse, VerifyCodeResponse } from '@beer-die/core';
import { type SQL, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.ts';
import { drainOutbox, type MailTransport } from '../src/mail/outbox.ts';
import { freshDatabase, resetTables, waitForLockWaiters } from './support/db.ts';
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

// What a code request leaves its caller holding: the request token the API answered with
// and, once the outbox drains, the code mailed to the address.
type Issued = { code: string; requestToken: string };

// Returns the request token.
async function requestCode(email: string): Promise<string> {
  const res = await post('/api/auth/code', { email });
  expect(res.status).toBe(202);
  return RequestCodeResponse.parse(await res.json()).requestToken;
}

// The code as the mail shows it: two groups of four.
const MAILED_CODE = /\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/;

function lastCodeMailedTo(email: string): string {
  const mail = sent.findLast((m) => m.to[0]?.address === email);
  const code = mail?.text.match(MAILED_CODE)?.[1];
  if (!code) throw new Error('no code was mailed to that address');
  return code;
}

async function mailedCode(email: string): Promise<Issued> {
  const requestToken = await requestCode(email);
  await drain();
  return { code: lastCodeMailedTo(email), requestToken };
}

// The same request with a well-formed code that isn't the one mailed.
function wrong(issued: Issued): Issued {
  const last = issued.code.at(-1) === '2' ? '3' : '2';
  return { ...issued, code: issued.code.slice(0, -1) + last };
}

// What someone who never asked for a code can send: a well-formed guess and a token of their
// own making.
function stranger(): Issued {
  return { code: '0000-0000', requestToken: randomBytes(32).toString('base64url') };
}

function verify(email: string, issued: Issued, client: 'web' | 'native' = 'web', opts: Opts = {}) {
  return post('/api/auth/verify', { email, ...issued, client }, opts);
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
  it('mails an 8-character code, in two groups of four, to the requested address', async () => {
    await requestCode('ana@example.com');
    await drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to[0]!.address).toBe('ana@example.com');
    // Crockford base32: no I, L, O, or U.
    expect(sent[0]!.text).toMatch(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/);
  });

  it('answers an unknown email with the same status and kind of body as a known one', async () => {
    await signInWeb('known@example.com');

    const known = await post('/api/auth/code', { email: 'known@example.com' });
    const unknown = await post('/api/auth/code', { email: 'unknown@example.com' });

    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    // Each is a fresh random token and nothing else, so neither says whether an account exists.
    const tokens = [
      RequestCodeResponse.parse(await known.json()).requestToken,
      RequestCodeResponse.parse(await unknown.json()).requestToken,
    ];
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('stores only a hash of the request token', async () => {
    const requestToken = await requestCode('ana@example.com');

    const [row] = await api.db.execute<{ request_token_sha256: string }>(
      sql`select request_token_sha256 from auth_codes`,
    );
    expect(row!.request_token_sha256).toBe(createHash('sha256').update(requestToken).digest('hex'));
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
    expect(JSON.stringify(queued!.params)).not.toContain(code.replace('-', ''));
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

  it('sends a full batch of codes in one drain when no other mail is waiting', async () => {
    for (let i = 0; i < 20; i++) await requestCode(`player${i}@example.com`);

    await drain();

    expect(sent).toHaveLength(20);
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
    const issued = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', issued);

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
    const issued = await mailedCode('ana@example.com');

    const res = await verify('Ana@Example.COM', issued);

    expect(res.status).toBe(200);
  });

  it('accepts the code typed in lower case without its hyphen', async () => {
    const issued = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', {
      ...issued,
      code: issued.code.replace('-', '').toLowerCase(),
    });

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
    const issued = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', wrong(issued));

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('INVALID_CODE');
  });

  it('still accepts the correct code after four wrong attempts', async () => {
    const issued = await mailedCode('ana@example.com');
    for (let i = 0; i < 4; i++) await verify('ana@example.com', wrong(issued));

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(200);
  });

  it('invalidates the code on the 5th wrong attempt', async () => {
    const issued = await mailedCode('ana@example.com');
    for (let i = 0; i < 5; i++) await verify('ana@example.com', wrong(issued));

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(401);
  });

  it('evaluates at most 5 guesses from a concurrent burst', async () => {
    const issued = await mailedCode('ana@example.com');

    await Promise.all(Array.from({ length: 10 }, () => verify('ana@example.com', wrong(issued))));

    // Every evaluated guess increments `attempts`; guesses past the cap are refused unseen.
    const [row] = await api.db.execute<{ attempts: number }>(sql`select attempts from auth_codes`);
    expect(row!.attempts).toBe(5);
  });

  it('accepts a code 1 s before its TTL', async () => {
    const issued = await mailedCode('ana@example.com');
    clock.advance(CODE_TTL - SECOND);

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(200);
  });

  it('rejects a code at TTL + 1 s', async () => {
    const issued = await mailedCode('ana@example.com');
    clock.advance(CODE_TTL + SECOND);

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(401);
  });

  it('rejects a code that was already used', async () => {
    const issued = await mailedCode('ana@example.com');
    await verify('ana@example.com', issued);

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(401);
  });

  it('still accepts the correct code after 20 wrong attempts by someone without its request token', async () => {
    const issued = await mailedCode('ana@example.com');
    for (let i = 0; i < 20; i++) await verify('ana@example.com', stranger());

    const res = await verify('ana@example.com', issued);

    expect(res.status).toBe(200);
  });

  it('counts no attempt against a code when the request token is not its own', async () => {
    await mailedCode('ana@example.com');

    for (let i = 0; i < 5; i++) await verify('ana@example.com', stranger());

    const [row] = await api.db.execute<{ attempts: number }>(sql`select attempts from auth_codes`);
    expect(row!.attempts).toBe(0);
  });

  it("refuses a correct code presented with another request's token", async () => {
    const mine = await mailedCode('ana@example.com');
    const theirs = await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', {
      code: mine.code,
      requestToken: theirs.requestToken,
    });

    // Unless the two random codes happen to match, which is one time in 2^40.
    expect(res.status).toBe(mine.code === theirs.code ? 200 : 401);
  });

  it('refuses a code presented for an email other than the one it was mailed to', async () => {
    const issued = await mailedCode('ana@example.com');

    const res = await verify('bo@example.com', issued);

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('INVALID_CODE');
  });

  it('rejects a verify with no request token with 422 VALIDATION', async () => {
    const { code } = await mailedCode('ana@example.com');

    const res = await post('/api/auth/verify', { email: 'ana@example.com', code, client: 'web' });

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
  });

  it('rate limits the 61st verify attempt from one IP within an hour', async () => {
    for (let i = 0; i < 60; i++) await verify(`player${i}@example.com`, stranger());

    const res = await verify('player60@example.com', stranger());

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RATE_LIMITED');
  });

  it('keeps an earlier code working when another is requested for the same email', async () => {
    const first = await mailedCode('ana@example.com');
    await mailedCode('ana@example.com');

    const res = await verify('ana@example.com', first);

    expect(res.status).toBe(200);
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

  it('expires a session 90 days after sign-in, however recently it was used', async () => {
    const cookie = await signInWeb('ana@example.com');
    for (let day = 20; day <= 80; day += 20) {
      clock.advance(20 * DAY);
      expect((await getMe({ cookie })).status).toBe(200);
    }
    clock.advance(10 * DAY);

    const res = await getMe({ cookie });

    expect(res.status).toBe(401);
  });

  it('keeps a session in use alive until 1 s before 90 days from sign-in', async () => {
    const cookie = await signInWeb('ana@example.com');
    for (let day = 20; day <= 80; day += 20) {
      clock.advance(20 * DAY);
      await getMe({ cookie });
    }
    clock.advance(10 * DAY - SECOND);

    const res = await getMe({ cookie });

    expect(res.status).toBe(200);
  });

  it('never stores an expiry later than 90 days from sign-in', async () => {
    const signedInAt = clock.now().getTime();
    const cookie = await signInWeb('ana@example.com');
    clock.advance(29 * DAY);
    await getMe({ cookie });
    clock.advance(29 * DAY);
    await getMe({ cookie });
    clock.advance(29 * DAY);

    await getMe({ cookie });

    const [row] = await api.db.execute<{ expires_at: string }>(
      sql`select expires_at from sessions`,
    );
    expect(new Date(row!.expires_at).getTime()).toBe(signedInAt + 90 * DAY);
  });

  it('expires a bearer session 90 days after sign-in too', async () => {
    const token = await signInNative('ana@example.com');
    for (let day = 20; day <= 80; day += 20) {
      clock.advance(20 * DAY);
      await getMe({ bearer: token });
    }
    clock.advance(10 * DAY);

    const res = await getMe({ bearer: token });

    expect(res.status).toBe(401);
  });

  it('sets the web cookie to last as long as the session can, 90 days', async () => {
    const res = await verify('ana@example.com', await mailedCode('ana@example.com'));

    expect(sessionSetCookie(res)).toMatch(/Max-Age=7776000(;|$)/);
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

  it('rejects a body with unknown keys with 422 VALIDATION, keeping the session', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout', { everywhere: true }, { cookie });

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('VALIDATION');
    expect((await getMe({ cookie })).status).toBe(200);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('revokes every session of the user, on every device', async () => {
    const cookie = await signInWeb('ana@example.com');
    const laptop = await signInWeb('ana@example.com');
    const phone = await signInNative('ana@example.com');

    const res = await post('/api/auth/logout-all', {}, { cookie });

    expect(res.status).toBe(204);
    expect((await getMe({ cookie })).status).toBe(401);
    expect((await getMe({ cookie: laptop })).status).toBe(401);
    expect((await getMe({ bearer: phone })).status).toBe(401);
  });

  it('clears the web session cookie', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout-all', {}, { cookie });

    expect(sessionSetCookie(res)).toMatch(/Max-Age=0/);
  });

  it("leaves other users' sessions alone", async () => {
    const cookie = await signInWeb('ana@example.com');
    const other = await signInWeb('bo@example.com');

    await post('/api/auth/logout-all', {}, { cookie });

    expect((await getMe({ cookie: other })).status).toBe(200);
  });

  it('lets the user sign in again afterwards', async () => {
    const cookie = await signInWeb('ana@example.com');
    await post('/api/auth/logout-all', {}, { cookie });

    const again = await signInWeb('ana@example.com');

    expect((await getMe({ cookie: again })).status).toBe(200);
  });

  it('requires a session', async () => {
    const res = await post('/api/auth/logout-all', {});

    expect(res.status).toBe(401);
  });

  it('rejects a cookie-authenticated request from a foreign Origin with 403', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout-all', {}, { cookie, origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect((await getMe({ cookie })).status).toBe(200);
  });

  it('rejects a body with unknown keys with 422 VALIDATION, keeping every session', async () => {
    const cookie = await signInWeb('ana@example.com');

    const res = await post('/api/auth/logout-all', { except: 'this' }, { cookie });

    expect(res.status).toBe(422);
    expect((await getMe({ cookie })).status).toBe(200);
  });
});

describe('sign-in lock order', () => {
  // Takes a row lock in a transaction of its own and holds it until the returned function
  // is called.
  async function hold(statement: SQL): Promise<() => Promise<void>> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const locked = new Promise<void>((resolve) => (taken = resolve));
    const done = api.db.transaction(async (tx) => {
      await tx.execute(statement);
      taken();
      await released;
    });
    await locked;
    return async () => {
      release();
      await done;
    };
  }

  // Polls, without waiting on it, until some transaction holds the email's code row.
  async function codeRowLocked(email: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      const free = await api.db.execute(
        sql`select 1 from auth_codes where email = ${email} for update skip locked`,
      );
      if (free.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the code row was never locked');
  }

  it('lets a code request and a verify for the same email wait on each other without deadlocking', async () => {
    const email = 'ana@example.com';
    const issued = await mailedCode(email);
    const releaseCode = await hold(sql`select 1 from auth_codes where email = ${email} for update`);
    const releaseUser = await hold(sql`select 1 from users where email = ${email} for share`);

    // The verify queues for the code row and the request for the first row it takes. Once the
    // verify holds the code row it waits for the user row, so a request that took the user
    // row first would then wait on the verify: a deadlock.
    const verifying = verify(email, issued);
    await waitForLockWaiters(api.db, 1);
    const requesting = post('/api/auth/code', { email });
    await waitForLockWaiters(api.db, 2);
    await releaseCode();
    await codeRowLocked(email);
    await releaseUser();
    const [verified, requested] = await Promise.all([verifying, requesting]);

    expect(api.logs.filter((e) => e.msg === 'unhandled error')).toEqual([]);
    expect(verified.status).toBe(200);
    expect(requested.status).toBe(202);
  });
});

describe('auth logging', () => {
  it('logs route templates but never the email, code, or token', async () => {
    const email = 'ana@example.com';
    const issued = await mailedCode(email);
    await verify(email, wrong(issued));
    const res = await verify(email, issued);
    const cookie = sessionSetCookie(res)!.split(';')[0]!;
    await getMe({ cookie });
    await post('/api/auth/logout', {}, { cookie });
    const token = await signInNative('bo@example.com');
    await getMe({ bearer: token });

    const logged = JSON.stringify(api.logs);
    expect(api.logs).toContainEqual(expect.objectContaining({ route: '/api/auth/verify' }));
    const secrets = [issued.code, issued.code.replace('-', ''), issued.requestToken];
    for (const secret of [email, 'bo@example.com', ...secrets, cookie.slice(8), token]) {
      expect(logged).not.toContain(secret);
    }
  });
});
