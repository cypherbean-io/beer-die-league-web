// Runs the API, the worker, and the Expo web dev server together. Stopping any stops all.
import { spawn } from 'node:child_process';
import { localEnv } from './local-env.ts';

const env = { ...process.env, ...localEnv };

const scripts = [
  ['apps/api', 'dev'],
  ['apps/api', 'dev:worker'],
  ['apps/app', 'dev'],
] as const;

const children = scripts.map(([workspace, script]) =>
  spawn('npm', ['run', script, '-w', workspace], { stdio: 'inherit', env }),
);

for (const child of children) {
  child.on('exit', (code) => {
    process.exitCode ??= code ?? 1;
    for (const other of children) other.kill();
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
