import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

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
