// `docker compose` on the whole stack with the test overrides in compose.test.yaml, e.g.
//   npm run stack -- up -d --build --wait db mailpit migrate api worker web
// Supplies throwaway AUTH_SECRET, APP_DB_PASSWORD, and BACKUP_DB_PASSWORD values, so no
// secret lives in source. They are new on every run, so bring the API and worker up in the
// same command: the worker can only decrypt sign-in codes queued under the same AUTH_SECRET.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const throwaway = () => randomBytes(32).toString('base64url');

const { status } = spawnSync(
  'docker',
  ['compose', '-f', 'compose.yaml', '-f', 'compose.test.yaml', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      AUTH_SECRET: throwaway(),
      APP_DB_PASSWORD: throwaway(),
      BACKUP_DB_PASSWORD: throwaway(),
      ...process.env,
    },
  },
);
process.exitCode = status ?? 1;
