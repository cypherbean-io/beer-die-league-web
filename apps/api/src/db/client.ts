import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export function createDb(url: string) {
  const client = postgres(url);
  return { db: drizzle(client), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
