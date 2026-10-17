// Runs the API and the Expo web dev server together. Stopping either stops both.
import { spawn } from 'node:child_process';
import { localEnv } from './local-env.ts';

const env = { ...process.env, ...localEnv };

const children = ['apps/api', 'apps/app'].map((workspace) =>
  spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit', env }),
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
