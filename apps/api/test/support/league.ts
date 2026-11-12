import { findOrCreateUser } from '../../src/auth/otp.ts';
import { createSession } from '../../src/auth/sessions.ts';
import { runCli } from '../../src/cli.ts';
import type { Clock } from '../../src/clock.ts';
import type { Db } from '../../src/db/client.ts';

// A signed-in caller. Sessions are minted with the real createSession as native bearer
// tokens, so tests don't spend the per-IP sign-in-code budget; the cookie path is covered
// in auth.test.ts.
export type Caller = { userId: string; token: string };

export async function signIn(db: Db, clock: Clock, email: string): Promise<Caller> {
  return db.transaction(async (tx) => {
    const userId = await findOrCreateUser(tx, email, clock.now());
    const token = await createSession(tx, { userId, client: 'native', now: clock.now() });
    return { userId, token };
  });
}

export type CliRun = { code: number; stdout: string[]; stderr: string[] };

export async function cli(db: Db, clock: Clock, argv: string[]): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    db,
    clock,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

// Bootstraps a league through the CLI, exactly as an operator would.
export async function createLeague(
  db: Db,
  clock: Clock,
  input: { name: string; email: string; displayName: string },
): Promise<{ leagueId: string; membershipId: string }> {
  const run = await cli(db, clock, [
    'create-league',
    '--name',
    input.name,
    '--commissioner-email',
    input.email,
    '--display-name',
    input.displayName,
  ]);
  if (run.code !== 0) throw new Error(`create-league failed: ${run.stderr.join('\n')}`);
  return JSON.parse(run.stdout.join('\n')) as { leagueId: string; membershipId: string };
}

type CallOpts = { as?: Caller; body?: unknown };

// JSON over HTTP with a bearer token. Writes always carry a JSON content type, which the
// CSRF guard requires even for a bodiless DELETE.
export function client(baseUrl: string) {
  return (method: string, path: string, opts: CallOpts = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (opts.as) headers.authorization = `Bearer ${opts.as.token}`;
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };
}

// Approving a member and changing a role are logged (covered in membership.test.ts). Suites
// about something else do both only to build their fixture, so their log helpers leave these
// entries out and assert on what the action under test wrote.
const MEMBERSHIP_SETUP = ['member.approved', 'member.role_changed'];

export function fromMembershipSetup(entry: { action: string }): boolean {
  return MEMBERSHIP_SETUP.includes(entry.action);
}
