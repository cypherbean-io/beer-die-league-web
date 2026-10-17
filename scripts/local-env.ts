// Defaults for local dev and tests, matching the `db` service in compose.yaml (trust auth,
// bound to 127.0.0.1). A value already set in the environment always wins.
export const localEnv = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/beerdie',
};
