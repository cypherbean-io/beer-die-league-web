import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate.ts';
import { localEnv } from '../../../scripts/local-env.ts';
import { TEMPLATE_DB, withDatabase } from './support/db.ts';

// Builds a migrated template database once per run; each test file clones it. Vitest's
// `test.env` doesn't reach globalSetup, so the URL comes from localEnv directly.
export default async function setup(): Promise<void> {
  const admin = postgres(localEnv.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.unsafe(`create database ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  await runMigrations(withDatabase(localEnv.DATABASE_URL, TEMPLATE_DB));
}
