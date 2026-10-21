import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Names that hold secrets, nested where a root-only .dockerignore pattern would miss them.
const SECRET_FILES = ['.env', '.env.local', 'secrets/token', 'tls.pem', 'tls.key'];

// The files under `dir` that a build with the repo's .dockerignore can see.
function contextFiles(dir: string): Promise<string[]> {
  const dockerfile = `FROM alpine\nCOPY . /ctx\nRUN cd /ctx && find ${dir} -type f\n`;
  return new Promise((resolve, reject) => {
    const build = spawn(
      'docker',
      ['build', '--no-cache', '--progress=plain', '--output', 'type=cacheonly', '-f', '-', '.'],
      { cwd: ROOT },
    );
    let output = '';
    build.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    build.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    build.on('error', reject);
    build.on('close', (code) => {
      if (code !== 0) return reject(new Error(`docker build exited ${code}:\n${output}`));
      const paths = [...output.matchAll(/^#\d+ [\d.]+ (\S+)$/gm)].map((m) => m[1]!);
      resolve(paths.filter((p) => p.startsWith(`${dir}/`)));
    });
    build.stdin.end(dockerfile);
  });
}

describe('the Docker build context', () => {
  // Under apps/app, which the web image copies whole.
  const dir = `apps/app/.context-probe-${randomUUID().slice(0, 8)}`;
  let files: string[];

  beforeAll(async () => {
    for (const name of [...SECRET_FILES, 'control.txt']) {
      const path = join(ROOT, dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'probe\n');
    }
    files = await contextFiles(dir);
  });

  afterAll(() => {
    rmSync(join(ROOT, dir), { recursive: true, force: true });
  });

  it('includes an ordinary file next to them', () => {
    expect(files).toContain(`${dir}/control.txt`);
  });

  it.each(SECRET_FILES)('leaves out a nested %s', (name) => {
    expect(files).not.toContain(`${dir}/${name}`);
  });
});
