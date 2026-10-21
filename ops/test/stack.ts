// Helpers for tests that run against the whole Compose stack, as `npm run verify` brings it
// up: `npm run stack -- up -d --build --wait db mailpit migrate api worker web`.
import { execFile } from 'node:child_process';
import { type IncomingHttpHeaders, type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// APP_ORIGIN in compose.test.yaml.
export const ORIGIN = 'https://localhost';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const execFileAsync = promisify(execFile);

// Postgres in the test stack, as `npm test` reaches it (compose.test.yaml).
export const STACK_DATABASE_URL = 'postgres://postgres@127.0.0.1:5432/beerdie';

type ComposeOpts = {
  // Compose files to pass with -f; [] means a bare `docker compose`. Default: the test stack.
  files?: string[];
  project?: string;
  env?: Record<string, string>;
};

export async function composeWith(opts: ComposeOpts, ...args: string[]): Promise<string> {
  const files = opts.files ?? ['compose.yaml', 'compose.test.yaml'];
  const project = opts.project ? ['-p', opts.project] : [];
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', ...files.flatMap((f) => ['-f', f]), ...project, ...args],
    { cwd: ROOT, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

// `docker compose` with the test overrides. Only for commands that leave the running
// services alone (exec, logs, `run --no-deps`): the throwaway secrets that scripts/stack.ts
// supplied are not passed again.
export function compose(...args: string[]): Promise<string> {
  return composeWith({}, ...args);
}

// Caddy issues the localhost certificate from its own local CA; trust exactly that root.
let rootCa: Promise<string> | undefined;
function caddyRootCa(): Promise<string> {
  rootCa ??= compose('exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt');
  return rootCa;
}

export type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

type RequestOpts = { method?: string; headers?: Record<string, string>; body?: string };

// One HTTP(S) request to the stack. `target` is a path on ORIGIN or an absolute URL.
export async function request(target: string, opts: RequestOpts = {}): Promise<Reply> {
  const url = new URL(target, ORIGIN);
  const options = { method: opts.method ?? 'GET', headers: opts.headers };
  const ca = url.protocol === 'https:' ? await caddyRootCa() : undefined;
  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on('error', reject);
    };
    const req = ca
      ? httpsRequest(url, { ...options, ca }, onResponse)
      : httpRequest(url, options, onResponse);
    req.on('error', reject);
    req.end(opts.body);
  });
}
