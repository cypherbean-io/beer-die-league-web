import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from '../../src/app.ts';
import { type Clock, systemClock } from '../../src/clock.ts';
import { createDb, type Db } from '../../src/db/client.ts';
import type { Log, LogEntry } from '../../src/log.ts';

export const APP_ORIGIN = 'http://app.test';

export type TestApi = {
  baseUrl: string;
  db: Db;
  authSecret: string;
  logs: LogEntry[];
  stop: () => Promise<void>;
};

// Serves the real app over HTTP on an ephemeral port, backed by the given database. Log
// lines are captured instead of printed.
export async function startApi(
  databaseUrl: string,
  opts: { clock?: Clock; trustProxy?: boolean } = {},
): Promise<TestApi> {
  const { db, close } = createDb(databaseUrl);
  const logs: LogEntry[] = [];
  const log: Log = (entry) => logs.push(entry);
  const authSecret = randomBytes(32).toString('base64url');
  const app = createApp({
    db,
    clock: opts.clock ?? systemClock,
    config: { authSecret, appOrigin: APP_ORIGIN, trustProxy: opts.trustProxy ?? false },
    log,
  });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    authSecret,
    logs,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await close();
    },
  };
}
