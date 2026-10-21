import { describe, expect, it } from 'vitest';
import { composeWith } from './stack.ts';

type Config = {
  name: string;
  services: Record<string, { image?: string; build?: unknown }>;
};

async function config(files: string[]): Promise<Config> {
  return JSON.parse(await composeWith({ files }, 'config', '--format', 'json')) as Config;
}

function builtImages(c: Config): string[] {
  return Object.values(c.services)
    .filter((service) => service.build !== undefined)
    .map((service) => service.image ?? '');
}

const PRODUCTION = ['compose.yaml'];

// A bare `docker compose` (dev, with compose.override.yaml) and the test stack.
describe.each([
  ['dev', []],
  ['test', ['compose.yaml', 'compose.test.yaml']],
])('the %s configuration', (_label, files) => {
  it("is not production's Compose project, so it never touches its containers or volumes", async () => {
    const [production, other] = await Promise.all([config(PRODUCTION), config(files)]);

    expect(other.name).not.toBe(production.name);
  });

  it('builds no image under a tag production runs, so it cannot swap in its own build', async () => {
    const [production, other] = await Promise.all([config(PRODUCTION), config(files)]);
    const productionTags = new Set(builtImages(production));

    expect(builtImages(other).filter((tag) => productionTags.has(tag))).toEqual([]);
  });
});
