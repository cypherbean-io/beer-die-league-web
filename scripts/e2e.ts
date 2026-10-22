// The Playwright suite (e2e/) against the test stack, which must already be up:
//   npm run stack -- up -d --wait db mailpit migrate api worker web
// Pass spec files to run only those: `npm run e2e -- e2e/xss.spec.ts`.
// The Playwright container can't run the CLI, so this bootstraps a league per spec first,
// with emails unique to the run, then runs the suite in the `e2e` service (compose.test.yaml).
// Compose is called directly, not through scripts/stack.ts, so the running services keep the
// throwaway secrets they were started with.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { COMMISSIONER_NAME, commissionerEmail, leagueName, SPECS } from '../e2e/seed.ts';

// The test project by name, so COMPOSE_PROJECT_NAME can never point this at production.
const COMPOSE = [
  'compose',
  '-f',
  'compose.yaml',
  '-f',
  'compose.test.yaml',
  '-p',
  'beer-die-league-web',
];
const run = randomBytes(4).toString('hex');

function compose(...args: string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], { encoding: 'utf8' });
}

for (const spec of SPECS) {
  const out = compose(
    'exec',
    '-T',
    'api',
    'node',
    'src/cli.ts',
    'create-league',
    '--name',
    leagueName(spec, run),
    '--commissioner-email',
    commissionerEmail(spec, run),
    '--display-name',
    COMMISSIONER_NAME,
  );
  const { leagueId } = JSON.parse(out.trim().split('\n').at(-1)!) as { leagueId: string };
  console.log(`seeded ${spec}: league ${leagueId}`);
}

// Every browser in the suite signs in from one address. Its per-address budgets would carry
// over between runs within the hour, so each run starts with them fresh.
compose(
  'exec',
  '-T',
  'db',
  'psql',
  '-U',
  'postgres',
  '-d',
  'beerdie',
  '-c',
  "delete from rate_limits where key like 'ip:%' or key like 'verify-ip:%'",
);

// Made here, as the host user: Docker would create a missing bind-mount source as root.
mkdirSync('playwright-report', { recursive: true });

// Any arguments go to `playwright test`.
const args = process.argv.slice(2);
const command =
  args.length === 0 ? [] : ['node', 'node_modules/@playwright/test/cli.js', 'test', ...args];
const { status } = spawnSync(
  'docker',
  [...COMPOSE, 'run', '--rm', '--no-deps', 'e2e', ...command],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_RUN: run,
      E2E_UID: String(process.getuid?.() ?? 1000),
      E2E_GID: String(process.getgid?.() ?? 1000),
    },
  },
);
process.exitCode = status ?? 1;
