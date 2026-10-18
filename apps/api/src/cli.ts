// Operator CLI for bootstrap tasks the API deliberately doesn't offer: creating a league
// and recovering one whose commissioners are gone. Prints ids only, never emails or names.
import { DisplayName, Email, LeagueName } from '@beer-die/core';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { type Clock, systemClock } from './clock.ts';
import { createDb, type Db } from './db/client.ts';
import { createLeague, promoteCommissioner } from './domain/leagues.ts';
import { safeErrorFields } from './log.ts';

const USAGE = [
  'Usage:',
  '  cli create-league --name <name> --commissioner-email <email> --display-name <name>',
  '  cli promote-commissioner --league-id <uuid> --email <email>',
].join('\n');

export type CliDeps = {
  db: Db;
  clock: Clock;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

class UsageError extends Error {}

// parseArgs messages quote the offending argument, which may be a name or an email, so each
// error code gets a fixed message instead.
const PARSE_ERRORS: Record<string, string> = {
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'Unexpected argument. Quote values that contain spaces.',
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Unknown option.',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'An option is missing its value.',
};

function parseFlags<S extends z.ZodObject>(args: string[], schema: S): z.output<S> {
  const options = Object.fromEntries(
    Object.keys(schema.shape).map((name) => [name, { type: 'string' as const }]),
  );
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new UsageError(PARSE_ERRORS[String(code)] ?? 'Invalid arguments.');
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    // Issue messages are fixed strings; they never echo the rejected value.
    const problems = parsed.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`);
    throw new UsageError(problems.join('\n'));
  }
  return parsed.data;
}

const CreateLeagueFlags = z.strictObject({
  name: LeagueName,
  'commissioner-email': Email,
  'display-name': DisplayName,
});

const PromoteCommissionerFlags = z.strictObject({
  'league-id': z.uuid(),
  email: Email,
});

// Returns the process exit code: 0 on success, 1 when the command failed, 2 on bad usage.
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === 'create-league') {
      const flags = parseFlags(args, CreateLeagueFlags);
      const ids = await createLeague(deps.db, {
        name: flags.name,
        commissionerEmail: flags['commissioner-email'],
        displayName: flags['display-name'],
        now: deps.clock.now(),
      });
      deps.stdout(JSON.stringify(ids));
      return 0;
    }
    if (command === 'promote-commissioner') {
      const flags = parseFlags(args, PromoteCommissionerFlags);
      const membershipId = await promoteCommissioner(deps.db, {
        leagueId: flags['league-id'],
        email: flags.email,
      });
      if (!membershipId) {
        deps.stderr('No approved membership in that league has that email.');
        return 1;
      }
      deps.stdout(JSON.stringify({ membershipId }));
      return 0;
    }
    throw new UsageError(command ? 'Unknown command.' : 'Missing command.');
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.stderr(`${err.message}\n\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { db, close } = createDb(databaseUrl);
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      db,
      clock: systemClock,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
  } catch (err) {
    // Postgres messages can quote the values involved, so only the class and code are shown.
    console.error(JSON.stringify({ level: 'error', msg: 'cli failed', ...safeErrorFields(err) }));
    process.exitCode = 1;
  } finally {
    await close();
  }
}
