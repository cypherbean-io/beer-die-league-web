import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from './stack.ts';

const DAY_S = 24 * 60 * 60;

// A shell script in a one-off backup container, which has the backups volume at /backups.
function inBackup(script: string, env: Record<string, string> = {}): Promise<string> {
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return compose(
    'run',
    '--rm',
    '--no-deps',
    '-T',
    ...vars,
    '--entrypoint',
    'sh',
    'backup',
    '-c',
    script,
  );
}

function runBackup(env: Record<string, string> = {}): Promise<string> {
  return inBackup('/ops/backup.sh once', env);
}

async function dumps(): Promise<Map<string, string>> {
  const out = await inBackup(
    'cd /backups && for f in *.dump; do [ -e "$f" ] && stat -c "%n %a" "$f"; done; true',
  );
  return new Map(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  );
}

// Seeds a file named like a dump, `daysOld` days old by the container's own clock.
function seed(name: string, daysOld: number): Promise<string> {
  return inBackup(`touch -d "@$(( $(date +%s) - ${daysOld * DAY_S} ))" "/backups/${name}"`);
}

describe('ops/backup.sh', () => {
  const run = randomUUID().slice(0, 8);
  const old = `beerdie-test-${run}-old.dump`;
  // Past 14 days by the next nightly run, a day from now.
  const aging = `beerdie-test-${run}-aging.dump`;
  const recent = `beerdie-test-${run}-recent.dump`;
  // What a run killed mid-dump leaves behind.
  const oldPartial = `.beerdie-test-${run}-old.dump.partial`;
  let before: Map<string, string>;
  let after: Map<string, string>;
  let afterAllFiles: string[];
  let created: string[];

  beforeAll(async () => {
    await seed(old, 15);
    await seed(aging, 13.5);
    await seed(recent, 12);
    await seed(oldPartial, 15);
    before = await dumps();
    await runBackup();
    after = await dumps();
    afterAllFiles = (await inBackup('ls -A /backups')).trim().split('\n');
    created = [...after.keys()].filter((name) => !before.has(name));
  });

  afterAll(async () => {
    const names = [old, aging, recent, oldPartial, ...created]
      .map((n) => `"/backups/${n}"`)
      .join(' ');
    await inBackup(`rm -f ${names}`);
  });

  it('writes one new dump', () => {
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^beerdie-\d{8}T\d{6}Z\.dump$/);
  });

  it('writes a dump pg_restore can read, holding the schema', async () => {
    const listing = await inBackup(`pg_restore --list "/backups/${created[0]}"`);

    expect(listing).toMatch(/TABLE public audit_events/);
  });

  it('makes the dump readable by its owner only, since it holds PII', () => {
    expect(after.get(created[0]!)).toBe('600');
  });

  it('deletes dumps older than 14 days', () => {
    expect(before.has(old)).toBe(true);
    expect(after.has(old)).toBe(false);
  });

  // Runs are a day apart, so a dump left for the next run would outlive the 14 days.
  it('deletes a dump over 13 days old, which would be past 14 days by the next run', () => {
    expect(before.has(aging)).toBe(true);
    expect(after.has(aging)).toBe(false);
  });

  it('keeps dumps under 13 days old', () => {
    expect(after.has(recent)).toBe(true);
  });

  it('deletes a partial dump left by a killed run once it is older than 14 days', () => {
    expect(afterAllFiles).not.toContain(oldPartial);
  });

  // SPEC §4 and the in-app privacy note promise deleted data lasts at most 14 days in
  // backups, so the promise holds through a run of failed dumps too.
  it('still deletes dumps older than 14 days when pg_dump fails, leaving no partial file', async () => {
    const stale = `beerdie-test-${run}-stale.dump`;
    await seed(stale, 15);
    const seeded = (await inBackup('ls -A /backups')).trim().split('\n').sort();
    try {
      await expect(runBackup({ PGDATABASE: `no_such_db_${run}` })).rejects.toThrow();

      const files = (await inBackup('ls -A /backups')).trim().split('\n').sort();

      expect(seeded).toContain(stale);
      expect(files).toEqual(seeded.filter((name) => name !== stale));
    } finally {
      await inBackup(`rm -f "/backups/${stale}"`);
    }
  });
});
