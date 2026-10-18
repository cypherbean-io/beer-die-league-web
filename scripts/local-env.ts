import { randomBytes } from 'node:crypto';

// Defaults for local dev and tests, matching the `db` and `mailpit` services in compose.yaml
// (bound to 127.0.0.1). A value already set in the environment always wins.
export const localEnv = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/beerdie',
  APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://localhost:8081',
  SMTP_URL: process.env.SMTP_URL ?? 'smtp://127.0.0.1:1025',
  MAIL_FROM: process.env.MAIL_FROM ?? 'Beer Die League <no-reply@beerdie.localhost>',
  // Generated per `npm run dev` and shared by the API and worker it spawns, so no secret
  // lives in source. A restart only invalidates sign-in codes still outstanding.
  AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString('base64url'),
};
