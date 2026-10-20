import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Db } from '../../src/db/client.ts';

export const TEMPLATE_DB = 'beerdie_template';

function adminUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return databaseUrl;
}

// The same server as `baseUrl`, but a different database.
export function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

// A fresh database cloned from the migrated template (built in globalSetup.ts).
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `beerdie_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name} template ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(adminUrl(), name),
    drop: async () => {
      const sql = postgres(adminUrl(), { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await sql.end();
      }
    },
  };
}

// Waits (bounded) until `n` backends in this test's database are blocked on a lock.
export async function waitForLockWaiters(db: Db, n: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row!.waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${n} backends ever waited on a lock`);
}

// Empties every table between tests. audit_events refuses TRUNCATE (even one cascading from
// users, memberships, or leagues), so the reset turns triggers off for its own transaction,
// which only a superuser, as dev and tests connect, may do.
export async function resetTables(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(
      sql`truncate table confirmations, revision_players, game_revisions, games, seasons, audit_events, invites, memberships, leagues, email_outbox, sessions, auth_codes, rate_limits, users cascade`,
    );
  });
}
