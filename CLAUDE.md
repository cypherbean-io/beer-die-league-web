# Beer Die League - Web

<!-- Target: under 200 lines. If it grows past that, move topics into
     .claude/rules/<topic>.md with `paths:` frontmatter so they load on demand.
     HTML comments like this one are stripped before Claude sees the file. -->

A tracker for 2v2 beer die leagues. The app does not keep live scores. For each game it
records the final line for each player (points, including sink points, and sinks) and
the winner. From those it derives wins, losses, and stats in four scopes: season,
all-time (season games only), exhibition, and combined.

A result counts only once all four players confirm it from their accounts. A
commissioner can force-confirm for a player who stays silent; that action is audited. A
game that breaks the league rules also needs a commissioner to approve an override.

**Stack:**
- An Expo Router universal app, exported to the web now; the same code will build
  iOS/Android later.
- A Hono API on Node 26, with Postgres through Drizzle.
- An npm-workspaces TypeScript monorepo.

The work in flight is specified in `SPEC.md`. Read it when needed, but never `@`-import
it.

## Commands

<!-- The highest-value lines in this file. Claude cannot guess these. -->

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Services (dev/test) | `docker compose up -d --wait db mailpit` |
| Dev server | `npm run dev`: API on `:3000`, the outbox worker, and Expo web on `http://localhost:8081`, which proxies `/api` to the API. Run Migrate first. |
| Migrate | `docker compose run --rm migrate`, after the services are up |
| New migration | `npx drizzle-kit generate`, run in `apps/api`; commit the generated SQL |
| Dev sign-in codes | Mailpit UI at `http://localhost:8025` (the worker delivers them within a few seconds) |
| Test (all) | `npm test` (core unit tests + API integration tests; needs `db` running) |
| Test (stack) | `npm run test:stack`: Caddy, the API behind it, and backups, against the whole stack. Bring it up first with `npm run stack -- build && npm run stack -- up -d --wait db mailpit migrate api worker web`. |
| Test (single file) | `npx vitest run <path/to/file.test.ts>` |
| Lint | `npm run lint` (ESLint, then `prettier --check`) |
| Format | `npm run format` |
| Typecheck | `npm run typecheck` (root scripts, then every workspace) |
| Build | `npm run build` (`expo export --platform web` into `apps/app/dist`; the API has no build step). The `web` image runs it too. |
| Verify (all checks) | `npm run verify`: builds the images, brings the whole stack up with `compose.test.yaml`, then typecheck, lint, test, and stack tests |
| Production | `docker compose -f compose.yaml up -d --build --wait`, with the variables listed at the top of `compose.yaml` in `.env`. Bootstrap with `docker compose -f compose.yaml exec api node src/cli.ts create-league …`. |
| Bootstrap a league | `DATABASE_URL=postgres://postgres@127.0.0.1:5432/beerdie npm run cli -w apps/api -- create-league --name … --commissioner-email … --display-name …` (after Migrate). Prints the new ids only. `promote-commissioner --league-id … --email …` recovers a league with no commissioner. |

> **Not wired yet.** These come from SPEC.md and land in later delivery slices. Move each
> row into the table above once it works.
>
> | Task | Command | Lands in |
> | --- | --- | --- |
> | E2E | `docker compose -f compose.yaml -f compose.test.yaml run --rm e2e` | slice 8 |
> | Full `verify` | SPEC.md §6 step 4: E2E after the stack tests | slice 8 |

Prefer running a single test file over the whole suite while iterating.

## Architecture

<!-- Only what cannot be derived by reading the code: boundaries, invariants,
     and decisions with rationale. Not a directory listing. -->

- Modules:
  - `apps/api`: the Hono API, plus `worker.ts` and `cli.ts`.
  - `apps/app`: the Expo Router client.
  - `packages/core`: pure TypeScript (zod schemas, rules check, standings ranking).
  - `e2e/`: Playwright tests.
- Dependency direction: `apps/app → packages/core ← apps/api`. `packages/core` depends
  only on zod and does no I/O. The app never imports from `apps/api`.
- Rules that change stored state are enforced only in `apps/api/src/domain/`. Native
  apps must reuse the API unchanged, so no such logic goes in the client or in a
  web-only layer. The app runs the `packages/core` validators for instant feedback, and
  the server always runs them again.
- Team totals and `is_sub` are derived on the server. If the client sends values for
  them, they are ignored.
- Stats are derived at read time from the `counted_results` view, which reads each
  game's `confirmed_revision_id`. There are no stored counters, so there's nothing to
  drift.
- Revisions are immutable: a correction creates a new revision, never an edit in place.
  `audit_events` is append-only.
- A correction is validated against the game's `rules_snapshot`, taken at first
  submission, not against the current league rules. Editing the league rules never
  re-validates existing games.
- Expiry is evaluated lazily:
  - Every game write calls `settleExpired(game, now)` under the row lock before doing
    anything else.
  - Reads treat `now ≥ window_expires_at` as expired.
  - The worker only materializes expiry; correctness must never depend on it running.
- Games reference `memberships` (the per-league identity), not `users`. This lets
  account deletion anonymize a player without rewriting game history.

### Invariants (never violate)

1. **Confirmation.**
   - A game contributes to stats only through its `confirmed_revision_id`.
   - A revision becomes confirmed only when each of its four players has a confirmation,
     either given by the player or forced by a commissioner and recorded in
     `audit_events`.
   - If `rule_violations` is non-empty, a commissioner must also have approved an
     override.
   - This transition lives in exactly one function,
     `apps/api/src/domain/games.ts#settleRevision`. It runs inside a transaction holding
     `SELECT … FOR UPDATE` on the game row.
2. **Tenancy.**
   - Every league-scoped query is filtered by the `league_id` of the caller's resolved,
     approved membership, never by a value from the request body.
   - Non-members get `404` on every league resource; members without the required role
     get `403`.

## Conventions

- **TypeScript.** The API runs `.ts` files directly using Node 26 type stripping, with
  `erasableSyntaxOnly`. That rules out `enum`, `namespace`, and constructor parameter
  properties. Relative imports include the `.ts` extension.
- **Time.** Domain code never calls `Date.now()` or `new Date()`; it uses the injected
  `Clock` from `apps/api/src/clock.ts`, and tests use `FixedClock`. Timestamps are
  `timestamptz` in UTC. IDs are UUIDv7.
- **Validation.** Request and response shapes are zod schemas in
  `packages/core/src/schemas.ts`, shared by the API and the app. They are strict, so
  unknown keys are rejected.
- **API errors.** The body is `{ error: { code, message, details? } }`.

  | Status | Code / used for |
  | --- | --- |
  | `422` | `VALIDATION`: structural errors, never overridable |
  | `422` | `RULES_VIOLATION`: rule-check failures, overridable by a commissioner |
  | `409` | Stale revision, closed window, or idempotency mismatch |
  | `413` | Request body over 16 KB |

- **Email.** All email goes through `email_outbox`, drained by the worker. Never send
  mail inside a request or a transaction. Emails never contain stats or tokens.
- **Logging.** JSON lines. Log the route *template*, never the raw path, because invite
  tokens appear in paths. Never log:
  - email addresses
  - sign-in codes
  - session or invite tokens
  - `Cookie` or `Authorization` headers
  - request bodies
  - display names
  - raw IP addresses

## Workflow

- Work in plan mode for anything touching more than two files.
- Every change ships with a test. Run the relevant tests before calling a task done,
  and show the output rather than asserting success.
- Conventional Commits (`feat:`, `fix:`, `chore:`, ...). Branches: `type/short-slug`.
- Never commit directly to `main`; open a PR.

## Guardrails

<!-- Reminders only. Enforcement lives in .claude/settings.json and .claude/hooks/. -->

- IMPORTANT: never read, print, or copy the contents of `.env*`, `secrets/**`, or any
  private key. Read `.env.example` for variable *names* only.
- Do not add a dependency without asking first. Justify it and check its transitive
  footprint. The approved v1 dependencies are:

  | Area | Packages |
  | --- | --- |
  | API | hono, @hono/node-server, drizzle-orm, postgres, zod, nodemailer |
  | App | expo, expo-router, react-native-web, react-dom, @tanstack/react-query |
  | App (Expo peers, at the versions in Expo's `bundledNativeModules.json`) | react, react-native, expo-constants, expo-linking, react-native-screens, react-native-safe-area-context, @expo/metro-runtime |
  | Dev | typescript, drizzle-kit, vitest, @playwright/test, eslint, prettier, typescript-eslint, @eslint/js, @types/node, @types/react |

  `typescript` is pinned to `~6.0` because typescript-eslint supports only `<6.1`.
  Don't bump it to 7 until typescript-eslint supports it.

- Do not edit `.github/workflows/**` or `.claude/**` without an explicit request.

## Gotchas

<!-- Append here whenever a correction has to be given twice. Over time this becomes
     the highest-signal part of the file. -->

- `POST /api/auth/code` returns `202` even for unknown emails. That's deliberate: it
  prevents account enumeration. Don't change it to report "no such account".
- Correcting a game doesn't restart its expiry clock. The window runs from first
  submission (or from when a confirmed game was reopened).
- Node refuses to strip types from files under `node_modules`. Workspace packages
  resolve through a symlink to `packages/core`. If that ever breaks, fall back to `tsc`
  emit; don't add `tsx`.
- Integration tests run against real Postgres from Compose, with a fresh database per
  test file, and capture mail with nodemailer's JSON transport. E2E tests never sleep or
  change the clock, so expiry is tested only at the integration level, with
  `FixedClock`.
- The CSP allows inline styles because react-native-web needs them. Don't tighten that
  away.
- A bare `docker compose …` also loads `compose.override.yaml`, which is dev-only (trust
  auth, loopback Postgres). Production must pass `-f compose.yaml`. Production is its own
  Compose project (`beer-die-league`), so dev and test commands never touch its containers
  or volumes, and its Postgres auth comes from the committed `ops/pg_hba.conf`, never from
  the data volume.
- In production the API and worker connect as `beerdie_app`, with no UPDATE or DELETE on
  `audit_events`, and backups dump as the read-only `beerdie_backup`. `migrate` provisions
  both after every migration. Dev and tests connect as the owner, so a missing grant shows
  up only in `app-role.test.ts` or the stack.
