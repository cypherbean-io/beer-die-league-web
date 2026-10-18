import { defineConfig } from 'drizzle-kit';

// `npx drizzle-kit generate` (run in apps/api) writes SQL into src/db/migrations; commit it.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
