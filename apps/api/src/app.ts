import { Hono } from 'hono';
import type { Db } from './db/client.ts';
import { healthRoutes } from './routes/health.ts';

export function createApp(deps: { db: Db }) {
  return new Hono().basePath('/api').route('/', healthRoutes(deps.db));
}
