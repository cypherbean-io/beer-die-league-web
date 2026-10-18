import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { stdoutLog } from './log.ts';

const PORT = 3000;

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const app = createApp({ db, clock: systemClock, config, log: stdoutLog });

serve({ fetch: app.fetch, port: PORT }, (info) => {
  stdoutLog({ level: 'info', msg: 'api listening', port: info.port });
});
