Status: draft 2026-10-16

# Beer Die League Tracker: v1

## 1. Problem

A beer die league needs a shared record of who won, who lost, and who scored and sank
what. Without one, results get written down by whoever bothers, in whatever format, and
nobody else checks them. Disputes can't be settled, season standings can't be trusted,
and all-time stats don't exist.

Who it affects:

- **Players.** They want their record (W/L, points, sinks) to be accurate, and they want
  a say before anything is counted against them.
- **Commissioners.** They run seasons, approve members and teams, and settle the cases
  the rules don't cover.

The app does **not** keep live scores. It records each game's final per-player line
once, and that line counts only after the players confirm it.

## 2. Scope

### In

- A web app, built as an Expo universal app and exported to static web. The same
  codebase will produce iOS and Android builds later.
- A standalone HTTP API that owns every rule and invariant.
- Sign-in with a one-time email code. Opaque sessions: a cookie on web, a bearer token
  for future native clients.
- **League.** One league per deployment, but the schema is multi-league ready.
  Membership works through an invite link plus commissioner approval. Multiple
  commissioners are supported. Stats are members-only.
- **Configurable league rules**, editable at any time and audited: target score, win-by,
  sink point value, and whether a sink ends the game. Each game snapshots the rules at
  its first submission.
- **Games:**
  - Two kinds: *season* (registered teams, at most one sub per side) and *exhibition*
    (any four approved members).
  - Each game records a per-player line (points including sink points, and sinks) and
    a declared winner.
  - Every submission gets the full rules check. A game that fails it can be submitted
    for *commissioner override*.
- **Confirmation workflow:**
  - Revisions: a correction creates a new revision and resets confirmations.
  - An expiry window that starts at first submission and is not reset by corrections.
  - Commissioner force-confirm for players who stay silent, audited.
  - Reopening a confirmed game through a correction.
  - Lock rules for finalized seasons and the exhibition correction window.
- **Seasons:**
  - One active season at a time. The commissioner starts and ends it manually.
  - After the end, games already in flight can finish. The season finalizes once
    nothing is open.
  - Teams form by self-service pairing plus commissioner approval. The commissioner
    can edit rosters mid-season.
- **Stats:**
  - Per-player stats in four scopes: Season, All-time (season games only),
    Exhibition, and Combined.
  - Partnership stats derived from game history.
  - Season team standings with a configurable ranking order and minimum games.
- **Notifications:** an in-app inbox of pending confirmations, plus opt-out email per new
  revision, sent through a transactional outbox.
- **Offline tolerance:** the game form saves a local draft and offers manual retry. An
  idempotency key prevents duplicate games.
- **Account deletion** inside the app. The account is anonymized and its games are kept,
  with an option to keep the display name on historical games.
- An append-only audit log of commissioner actions, visible to all members.
- Docker Compose for local dev, tests, and production on a single VPS: Caddy for TLS and
  static web, Postgres, the API, a worker, and nightly backups.

### Out (explicitly)

- Live scoring or throw-by-throw logging.
- Native iOS/Android builds, App Store or Play Store submission, and push notifications.
  The architecture is ready for them; building them is a later spec.
- OAuth, Sign in with Apple, and Sign in with Google. The identity model allows linking
  them later.
- User-created leagues and a league switcher UI. Leagues are created by a CLI command.
- Playoffs, brackets, fixtures, or scheduling.
- Elo or other skill ratings.
- Public or shareable leaderboards.
- Any age gate. This was a deliberate decision. A future App Store listing will still
  need a mature age rating.
- A background offline sync queue or service worker. Only local drafts are in scope.
- Stats beyond W/L, points, and sinks (catches, plunks, and so on).
- A forfeit flag. Forfeits go through commissioner override.
- Reminder emails before expiry.
- Comments, chat, photos, and avatars.
- Importing historical results.
- CI/CD deploy pipelines and any change to `.github/workflows/**`.

## 3. Design

### 3.1 Stack and repo layout

npm workspaces, so there's no extra package-manager tooling. All TypeScript.

```
apps/api/                 Hono HTTP API + worker + CLI (Node 26, runs .ts via built-in
                          type stripping: erasableSyntaxOnly, no build step; fall back
                          to tsc emit only if workspace resolution fights it)
  src/index.ts            HTTP server bootstrap
  src/worker.ts           periodic sweep: expiry, season finalization, email outbox, purges
  src/cli.ts              create-league, promote-commissioner (bootstrap only)
  src/clock.ts            Clock interface; real + fixed implementations
  src/db/schema.ts        Drizzle schema; src/db/migrations/ (drizzle-kit, committed SQL)
  src/auth/               otp.ts, sessions.ts, middleware.ts, rateLimit.ts
  src/domain/             games.ts (state machine; THE invariant), seasons.ts, teams.ts,
                          membership.ts, deletion.ts, audit.ts
  src/stats/queries.ts    SQL aggregation over counted results
  src/mail/               outbox.ts, transport.ts (nodemailer SMTP), templates.ts
  src/routes/             auth, me, leagues, members, invites, seasons, teams, games,
                          inbox, stats, audit
apps/app/                 Expo Router app; web export now, iOS/Android later
  app/                    screens (see 3.8)
  src/api/                typed fetch client + @tanstack/react-query hooks
  src/drafts.ts           local draft store behind a Storage interface
packages/core/            pure TS, zod only, no I/O
  src/schemas.ts          zod request/response schemas shared by api and app
  src/rules.ts            checkStructure(), checkRules()
  src/standings.ts        rankStandings()
  src/partnership.ts      pairKey()
e2e/                      Playwright tests (run in the official Playwright image)
compose.yaml              db, mailpit, migrate, api, worker, web (Caddy)
compose.test.yaml         test overrides + e2e service
Caddyfile                 TLS, static web, /api reverse proxy, security headers
ops/backup.sh             nightly pg_dump, 14-day retention
```

**Dependency direction:** `apps/app → packages/core` and `apps/api → packages/core`.
`packages/core` depends on nothing but zod. The app must never import from `apps/api`.
Business rules that affect stored state are enforced **only** in `apps/api/src/domain/`.
The app runs the same `packages/core` validators for instant feedback, but the server
always runs them again.

**Approved dependencies:**

| Area | Packages |
| --- | --- |
| API runtime | hono, @hono/node-server, drizzle-orm, postgres, zod, nodemailer (6 packages total; none has transitive dependencies) |
| Client | expo, expo-router, react-native-web, react-dom, @tanstack/react-query (about 553 transitive packages, inherent to Expo) |
| Dev | typescript, drizzle-kit, vitest, @playwright/test, eslint, prettier |

Anything else needs the user to approve it first.

**Rejected alternatives:**

- **Next.js on the web with Expo later.** That means two UI codebases.
- **Supabase.** Vendor coupling, and the invariant would live in SQL/RLS, which is hard
  to unit test.
- **Flutter.** Its web output renders to a canvas, so it performs worst on the platform
  we're launching first.
- **Better Auth.** A large dependency tree for about 300 lines of logic we can own.
- **pnpm.** Extra tooling for no v1 benefit.

### 3.2 Tenancy

- Every league-scoped table carries `league_id`.
- League routes live under `/api/leagues/:leagueId/...`.
- Middleware resolves the caller's **approved** membership for `:leagueId` and passes it
  into the domain layer.
- Domain and query functions take `leagueId` from that membership, never from the
  request body.
- A non-member gets `404` on every league resource, so the API doesn't reveal that a
  league exists. A member without the required role gets `403`.
- The v1 UI shows the caller's first league.

### 3.3 Data model (Postgres; all timestamps `timestamptz` UTC; ids are UUIDv7)

| Table | Key columns / constraints |
| --- | --- |
| `users` | `email citext unique null` (null after deletion), `created_at`, `deleted_at` |
| `auth_codes` | `email`, `code_hmac`, `expires_at`, `attempts`, `consumed_at`. Requesting a new code invalidates the email's earlier codes. |
| `sessions` | `user_id`, `token_sha256 unique`, `client ('web'\|'native')`, `last_used_at`, `expires_at` (30 days after last use) |
| `rate_limits` | `key` (`email:<hmac>` or `ip:<hmac>`), `window_start`, `count` |
| `leagues` | `name`, rules (`target_score` ≥1 default 11, `win_by` ≥1 default 2, `sink_points` ≥0 default 0, `sink_ends_game` default false), `confirmation_window_days` 1–30 default 7, `exhibition_correction_window_days` 0–365 default 30 |
| `memberships` | `league_id`, `user_id`, `display_name`, `name_key` (NFKC + lowercase; `unique(league_id, name_key)`), `role ('member'\|'commissioner')`, `status ('pending'\|'approved'\|'removed'\|'left'\|'deleted')`, `email_notifications bool`, `keep_name_on_delete bool`. Games reference **memberships**, not users. |
| `invites` | `league_id`, `token_sha256`, `created_by`, `expires_at` (default 14 days), `revoked_at` |
| `seasons` | `league_id`, `name`, `status ('draft'\|'active'\|'ended'\|'finalized')`, `started_at`, `ended_at`, `finalized_at`, `standings_config jsonb`. A partial unique index allows at most one `active` season per league. |
| `season_teams` | `season_id`, `name`, `status ('proposed'\|'accepted'\|'approved'\|'rejected'\|'withdrawn')`, `proposed_by` |
| `team_roster` | `team_id`, `season_id`, `membership_id`, `valid_from`, `valid_to null`. A partial unique index on `(season_id, membership_id) where valid_to is null` enforces one team per player per season. |
| `games` | `league_id`, `kind ('season'\|'exhibition')`, `season_id null`, `status ('pending'\|'confirmed'\|'expired'\|'voided')`, `confirmed_revision_id null`, `open_revision_id null`, `window_expires_at null`, `rules_snapshot jsonb`, `submitted_by`, `idempotency_key`, `payload_sha256`; `unique(league_id, submitted_by, idempotency_key)` |
| `game_revisions` | `game_id`, `number`, `created_by`, `played_at`, `side_a_team_id null`, `side_b_team_id null`, `winner ('A'\|'B')`, `rule_violations jsonb` (empty means it conforms), `override_status (null\|'requested'\|'approved'\|'rejected')`, `override_by`, `status ('open'\|'confirmed'\|'superseded'\|'expired'\|'voided'\|'rejected')` |
| `revision_players` | `revision_id`, `side`, `membership_id`, `is_sub` (derived by the server), `points` 0–99, `sinks` 0–99. Exactly 4 rows, `unique(revision_id, membership_id)`. |
| `confirmations` | `revision_id`, `membership_id`, `kind ('player'\|'forced')`, `forced_by null`, `created_at`; `unique(revision_id, membership_id)` |
| `audit_events` | Append-only: no UPDATE or DELETE grants for the app role. Columns: `league_id`, `actor_membership_id`, `action`, `target_type`, `target_id`, `actor_was_participant bool`, `details jsonb`, `created_at` |
| `email_outbox` | `user_id`, `template`, `params jsonb` (no stats, no secrets), `attempts`, `next_attempt_at`, `sent_at`, `last_error` |

Stats are **derived at read time** from a `counted_results` view. It has one row per
player per counted game: the game's `confirmed_revision_id` joined to `revision_players`,
plus kind, season, side, partner, team, `is_sub`, `won`, `points`, `sinks`, and
opponents' points. There are no stored counters that can drift. Materialized views can
come later if reads ever become slow.

### 3.4 The invariant (amends CLAUDE.md)

> A game contributes to stats only through its `confirmed_revision_id`. A revision
> becomes confirmed only when:
>
> 1. each of its four players has a confirmation, either given by the player or forced
>    by a commissioner and recorded in `audit_events`; and
> 2. if `rule_violations` is non-empty, a commissioner has approved an override.
>
> The confirmation transition is implemented in exactly one function,
> `domain/games.ts#settleRevision`. It runs inside a transaction holding
> `SELECT … FOR UPDATE` on the game row.

CLAUDE.md currently says all four players must confirm, with no exceptions. The
implementation PR must replace that text with the invariant above, and also fill in the
Architecture invariants and the Commands table.

### 3.5 Game lifecycle

```
submit ──► PENDING ──(4 confirmations [+ override if violations])──► CONFIRMED
           │  ▲                                                         │  ▲
           │  └─ correction: new revision; confirmations reset;         │  │ new revision
           │     author's confirmation recorded; window NOT reset       │  │ confirmed: replaces
           ├─ now ≥ window_expires_at ─► EXPIRED (never counts)         │  │ counted revision
           └─ a player removed/left/deleted ─► VOIDED      correction ──┘  │
                                                           (reopen) ──► CONFIRMED + open revision
                                                     open revision expires/voids/rejected ─┘
                                                     → old confirmed revision keeps counting
```

**Submitting**

- `POST /games` carries `{ idempotencyKey, kind, seasonId?, playedAt, sides, winner,
  requestOverride? }`.
- The submitter must be one of the four players. Submitting counts as their
  confirmation.
- The server stores `rules_snapshot` from the current league rules and sets
  `window_expires_at = now + confirmation_window_days`.

**Correcting.** `POST /games/:id/revisions` carries `{ baseRevisionId, …payload }`.

- Only the four players of the base revision may correct it.
- If `baseRevisionId` isn't the current open revision (or, when reopening, the confirmed
  revision), the server returns `409 CONFLICT`.
- A correction is checked against the game's `rules_snapshot`, not the current rules.
- The new revision supersedes the previous open revision. Confirmations attach to a
  specific revision, so they reset automatically.
- The previous revision's override approval doesn't carry over.

**Confirming.** `POST /games/:id/revisions/:rid/confirm`.

- The caller must be one of that revision's players.
- If the revision isn't open, the server returns `409`. This also covers revisions that
  have since expired.
- Confirming twice is idempotent.
- The client always sends the revision id it actually displayed, so nobody can confirm
  numbers they haven't seen.

**Reopening a confirmed game**

- Any of the four players can reopen with a correction whose `baseRevisionId` is the
  confirmed revision.
- The window starts at that moment.
- Allowed only while:
  - *exhibition:* `now < confirmed_at + exhibition_correction_window_days`.
  - *season:* the season is `active`.
- Once a season has ended, its confirmed games can't be reopened. Revisions already open
  can still be corrected or confirmed until their window closes.

**Expiry**

- Expiry is evaluated lazily. Every game write calls `settleExpired(game, now)` under
  the row lock before doing anything else. Reads treat `now ≥ window_expires_at` as
  expired.
- The worker materializes expiry every 60 s, but correctness never depends on the worker
  running.

**Force-confirm.** `POST …/revisions/:rid/force-confirm` with `{ membershipIds }`.

- Commissioners only.
- Applies only to listed players who have no confirmation on that open revision.
- Writes one audit event per player. `actor_was_participant` is set when the
  commissioner played in the game, and that flag is shown on the game page.
- A player who disagrees can still propose a correction, which resets everything.

**Override**

- Without `requestOverride`, a revision with `checkRules` violations is rejected with
  `422 RULES_VIOLATION` and the list of violations.
- With `requestOverride`, the revision is stored with `override_status = 'requested'`
  and commissioners are notified by email.
- `POST …/revisions/:rid/override { decision }`:
  - `approve` lets the revision confirm once all four confirmations exist, in either
    order.
  - `reject` sets the revision's status to `rejected`. Players can still correct it
    within the window.
- A playing commissioner may decide on an override; it is audited with
  `actor_was_participant`.

**Voiding.** When a member is removed, leaves, or deletes their account, every open
revision they appear in is voided in the same transaction:

- If the game was never confirmed, the game is voided too.
- If the game is confirmed, its confirmed revision keeps counting.

**Concurrency**

- All transitions hold the game row lock.
- When concurrent final confirmations race, exactly one of them performs the
  transition, writes the audit entry, and enqueues the email.

### 3.6 Validation (`packages/core/src/rules.ts`)

```ts
type Rules = { targetScore: number; winBy: number; sinkPoints: number; sinkEndsGame: boolean };
type PlayerLine = { membershipId: string; side: 'A' | 'B'; points: number; sinks: number };
type ResultInput = { players: PlayerLine[]; winner: 'A' | 'B' };
type RuleViolation = { code: 'BELOW_TARGET' | 'MARGIN_TOO_SMALL' | 'ALREADY_OVER'
  | 'LOSER_SINK_WHEN_SINK_ENDS' | 'MULTIPLE_SINKS_WHEN_SINK_ENDS' | 'SINK_AFTER_GAME_OVER';
  message: string };
function checkStructure(rules: Rules, input: ResultInput): StructureError[]; // never overridable → 422 VALIDATION
function checkRules(rules: Rules, input: ResultInput): RuleViolation[];       // [] = conforms; overridable
```

**Structural checks** (never overridable):

- Exactly 4 players, all distinct, 2 per side.
- Integer `points` and `sinks` in 0–99.
- Each player's `points ≥ sinks × sinkPoints`.
- A declared winner.

The server also checks that all four players are approved members, that `playedAt` is
not in the future, and the season constraints in 3.7.

**Rules check** (overridable):

- Team totals are the sums of the player lines (`Pw`, `Pl`, `Sw`, `Sl`), and
  `over(a, b) := a ≥ targetScore ∧ a − b ≥ winBy`.
- When `sinkEndsGame` is set, the losing team can't have a sink (`Sl = 0`) and the
  winning team has at most one (`Sw ≤ 1`).
- **The game ended on a sink** (`sinkEndsGame ∧ Sw = 1`). The state just before the
  sink, `(Pw − sinkPoints, Pl)`, must not already be over for either side. The winner
  may be trailing on points.
- **The game ended on points** (every other case).
  - `over(Pw, Pl)` must hold.
  - Some final scoring event `e` must exist for which `(Pw − e, Pl)` is not over for
    either side. `e` can be 1, if the winner has any non-sink points, or `sinkPoints`,
    if `Sw ≥ 1` and `sinkPoints ≥ 1`.
- In other words, the final score must be a legal end state, and the game must not have
  already ended one scoring event earlier. The check does not try to reconstruct the
  full order of points.

### 3.7 Seasons, teams, stats

**Lifecycle**

- `draft → active` (commissioner start; only one active season at a time) `→ ended`
  (commissioner end) `→ finalized`.
- A season finalizes automatically, in the worker or right after the triggering write,
  when no game in it has an open revision.
- Finalization locks the season's games and its `standings_config`.

**Teams**

- A member proposes a team with a partner, the partner accepts, and a commissioner
  approves.
- Each player can be on one roster per season.
- Commissioners can edit rosters at any time before finalization (audited). This closes
  the current roster row and opens a new one.
- Past games keep the players and team ids stored on their revisions, so a roster edit
  never rewrites history.

**Season game constraints**

- The season is `active`.
- Both sides are distinct `approved` teams in that season.
- `playedAt ≥ started_at`.
- Each side holds the team's current roster, with at most **one** sub per side.
- The server derives `is_sub`: a player not on the side's roster is a sub. A sub may be
  any approved member, including someone on a third team.
- The team gets the win or loss. The sub's points and sinks count toward the sub's own
  stats in that season.

**Player stats.** GP, W, L, Win%, Points, PPG, Sinks, Sinks/G, available in four scopes:

| Scope | Games counted |
| --- | --- |
| `season:<id>` | Season games in that season, including games played as a sub |
| `alltime` | All season games |
| `exhibition` | Exhibition games |
| `combined` | Every game |

**Partnership stats**

- The pair is keyed by `pairKey(a, b)`, its sorted membership ids, and covers the two
  people who actually played together, subs included.
- Shown per scope: GP, W, L, Win%, Points, Sinks.

**Standings (`rankStandings`)**

- Each team row has GP, W, L, Win%, PF, PA, Diff, and Sinks.
- `standings_config = { order: Metric[], minGames: number }`, where `Metric` is one of
  `win_pct | wins | point_diff | points_for | sinks | head_to_head`.
- Default: `['win_pct', 'head_to_head', 'point_diff', 'sinks']` with `minGames: 0`.
- `head_to_head` compares win% only within the group of teams still tied at that step;
  if those teams have no games against each other, it's a no-op.
- Teams still tied after the whole order share a rank, shown as "T-2" and ordered by
  name.
- Teams with `GP = 0` or `GP < minGames` are listed but unranked.

### 3.8 API and UI surface

**API** (JSON; every request validated by `packages/core` zod schemas; error body is
`{ error: { code, message, details? } }`):

| Group | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/code`, `POST /api/auth/verify`, `POST /api/auth/logout` |
| Me | `GET /api/me`, `PATCH /api/me`, `DELETE /api/me { keepDisplayName }` |
| Invites | `POST /api/invites/:token/join { displayName }` |
| League | `GET /leagues/:id`, `PATCH /leagues/:id/rules`, `PATCH /leagues/:id/settings` |
| Members | `GET /members`, `POST /members/:mid/{approve,reject,remove,role}`, `POST /invites`, `DELETE /invites/:iid`, `POST /leave` |
| Seasons | `POST /seasons`, `POST /seasons/:sid/{start,end}`, `PATCH /seasons/:sid/standings-config`, `GET /seasons/:sid/standings` |
| Teams | `POST /seasons/:sid/teams`, `POST /teams/:tid/{accept,approve,reject,withdraw}`, `PUT /teams/:tid/roster` |
| Games | `POST /games`, `GET /games`, `GET /games/:gid`, `POST /games/:gid/revisions`, `POST /games/:gid/revisions/:rid/{confirm,force-confirm,override}` |
| Inbox | `GET /inbox`: open revisions awaiting my confirmation |
| Stats | `GET /stats/players?scope=`, `GET /stats/players/:mid?scope=`, `GET /stats/partnerships?scope=` |
| Audit | `GET /audit` |

All groups after Invites are under `/api/leagues/:id`.

**UI (Expo Router, mobile-first)**

- **Sign in:** email, then a 6-digit code.
- **Join:** enter a display name, then wait on an "awaiting approval" screen.
- **Home:** inbox badge, standings snapshot, and a "Record game" button.
- **Record game:**
  - Choose Season or Exhibition. For a season game, my team is prefilled and I pick
    the opponent; "swap in sub" covers an absent partner.
  - Per-player points and sinks use large +/− steppers. I tap the winner explicitly.
  - Live `checkRules` feedback. When a game fails the check, the violations are listed
    and a secondary "Submit for commissioner review" button appears.
  - The draft autosaves.
- **Game detail:**
  - The current numbers and a per-player confirmation state: ✓, ✓ forced (with a
    participant flag when relevant), or pending.
  - A countdown to expiry and the revision history, with diffs.
  - Confirm and Propose correction buttons, plus the game's audit entries.
- **Stats:** scope tabs; tables for players and partnerships; player profiles.
- **Standings.**
- **Commissioner screens:** pending members, invite link, rules and settings, seasons and
  teams, the override queue, and force-confirm on the game page.
- **Account:** display name, email-notification toggle, sign out, and delete account
  (with a keep-name option).

**Drafts and retries**

- Opening the form creates a draft holding `crypto.randomUUID()` as its idempotency key.
- On web the draft persists in `localStorage`, behind a Storage interface.
- If the submit fails, the draft stays and a Retry button appears.
- A retry with the same key and payload returns the original game (`200`); the same key
  with a different payload returns `409`.
- The draft is cleared after the server confirms the submission.

### 3.9 Auth, email, ops

**Codes**

- 6 digits from `crypto.randomInt`.
- Stored as `HMAC-SHA256(AUTH_SECRET, email ‖ code)` and compared in constant time.
- 10-minute TTL, single use, and at most 5 verify attempts before the code is
  invalidated.
- Limits: 5 code requests per hour per email, and 20 per hour per IP. IPs are stored
  only as an HMAC.
- `POST /auth/code` always returns `202`.

**Sessions**

- 32 random bytes, encoded base64url; only their SHA-256 is stored.
- **Web:** `httpOnly; Secure; SameSite=Lax; Path=/api` cookie. Every state-changing
  request authenticated by cookie must send `Content-Type: application/json` with an
  `Origin` matching `APP_ORIGIN`.
- **Native:** `Authorization: Bearer` token.

**Email**

- Delivered through an outbox drained by the worker: nodemailer over SMTP, at most 5
  attempts with exponential backoff.
- Sending never blocks a request or happens inside its transaction.
- Templates:
  - Sign-in code.
  - "{name} submitted/corrected a game with you": sent to the other opted-in players,
    with a link and no stats.
  - "New member awaiting approval" and "Override requested", sent to commissioners.

**Ops**

- **Docker Compose services:**
  - `db` (Postgres)
  - `mailpit` (dev/test only)
  - `migrate` (one-shot drizzle-kit migrate)
  - `api` and `worker` (same image)
  - `web` (Caddy serving the `expo export --platform web` output and proxying `/api` to
    `api`, same origin)
- **Configuration:** environment variables only. `.env.example` lists the names:
  `DATABASE_URL`, `AUTH_SECRET`, `APP_ORIGIN`, `SMTP_URL`, `MAIL_FROM`.
- **Logs:** JSON lines on stdout, rotated by Docker.
- **Bootstrap:** `npm run cli -w apps/api -- create-league --name … --commissioner-email
  … --display-name …`

### 3.10 Suggested delivery slices (each slice ships with its screens and tests)

1. Workspace scaffold, Compose (db and mailpit), `packages/core` rules and standings with
   unit tests, and the CLAUDE.md commands and invariant.
2. Auth (codes, sessions, rate limits), the CLI bootstrap, membership, invites, and
   approval.
3. Games: submit, confirm, correct, expire, idempotency, inbox, and the email outbox.
4. Commissioner tools: force-confirm, override, the audit log, and rules and settings
   editing.
5. Seasons, teams, rosters, subs, finalization, and standings.
6. Stats scopes and partnerships.
7. Account deletion and member removal.
8. Production Compose: Caddy headers, backups, and the full E2E suite.

## 4. Security & privacy

**Data touched**

| Data | Sensitivity |
| --- | --- |
| Email addresses | PII |
| Display names | Pseudonymous, but often real names |
| Game records | Behavioral data about drinking, tied to identities |
| Session tokens, sign-in codes, invite tokens | Credentials |
| IP addresses | Transient, stored only as HMACs inside rate-limit windows |

There is no date of birth, no location, and no payment data.

**Trust boundaries**

- **Browser or native client → Caddy → API.** All input is untrusted. Every body and
  query is parsed with zod, bodies are limited to 16 KB (`413` above that), and the
  server recomputes team totals and `is_sub`. The client's validation result is never
  trusted.
- **API → Postgres.** Drizzle sends only parameterized queries. The app role has no
  UPDATE or DELETE on `audit_events`.
- **Worker → SMTP provider.** Emails carry only a display name, a link, or a sign-in
  code, never stats. Subjects are fixed strings; user text is never placed in headers.
- **Future native apps.** Bearer tokens will be stored in the platform keychain (a later
  spec).

**Attack surface and mitigations**

| Threat | Mitigation |
| --- | --- |
| Account enumeration | `/auth/code` always returns `202` with the same body and timing class |
| Brute-forcing sign-in codes | 5 attempts per code, 10-minute TTL, rate limits per email and per IP, constant-time comparison |
| Session theft | httpOnly + Secure cookie, only the token hash is stored, 30-day idle expiry, logout and account deletion revoke sessions |
| CSRF | SameSite=Lax cookie, plus the `Origin` and JSON content-type checks on writes. Bearer tokens are not subject to CSRF. |
| XSS | React escaping; no `dangerouslySetInnerHTML`. Display names: NFKC-normalized, 2–24 characters (letters, digits, space, `-_.'`). Caddy sets a CSP (`default-src 'self'`, `connect-src 'self'`, inline styles allowed for react-native-web) and `X-Content-Type-Options`. |
| Invite token leaks through the Referer header | `Referrer-Policy: no-referrer` and no third-party assets. Tokens are revocable and expire, and joining still requires approval. |
| IDOR / cross-league access | `leagueId` always comes from the resolved membership; non-members get `404`; role checks happen in the domain layer |
| Sock-puppet accounts faking games | Only approved members can appear in games; commissioners approve every join |
| Commissioner abuse (force-confirm, overrides on their own games) | Allowed by decision, but every such action is audited and visible to all members, flagged when the commissioner played |
| Duplicate or replayed submissions | Idempotency key plus a payload hash |
| Race conditions | Game row lock; one transition function |
| Large or malformed payloads | 16 KB body limit; zod schemas with strict integer bounds |

**Logging and redaction**

- **Logged:** request id, method, route *template* (never the raw path, because invite
  tokens appear in paths), status, latency, `membership_id` or `user_id`, and worker job
  outcomes.
- **Never logged:** email addresses, sign-in codes, session or invite tokens, `Cookie`
  and `Authorization` headers, request bodies, display names, and raw IPs.
- **Mail errors:** logged as provider error codes only.

**Privacy**

- Everything is visible to members only.
- Commissioners see emails only for members pending approval.
- **Account deletion** erases the email, sessions, codes, and outbox rows, and voids the
  member's open revisions. The display name becomes "Deleted player #N" unless the
  member chose to keep it. A kept name stays reserved and is marked as a former member.
  Confirmed games remain, so other players' records don't change.
- Re-registering with the same email creates a new, unlinked identity.
- **Backups:** nightly `pg_dump` files contain PII and are kept for 14 days, so deleted
  data lingers in backups for up to 14 days. The privacy note in the app says so.

## 5. Test plan

**Test setup**

- Vitest runs unit and integration tests. Integration tests run against real Postgres
  from Compose; each test file gets a fresh database cloned from a migrated template.
- The clock is injected (`FixedClock`). Mail goes through nodemailer's built-in JSON
  transport, captured at the process boundary.
- Nothing we own is mocked.
- Test names state the behavior under test.

### 5.1 `packages/core` unit tests

**`checkRules` table** (default rules unless stated: target 11, win-by 2, sink 0,
sinks don't end the game):

| Rules | Final score / sinks | Expected |
| --- | --- | --- |
| defaults | 11–9 | ok |
| defaults | 11–10 | MARGIN_TOO_SMALL |
| defaults | 10–8 | BELOW_TARGET |
| defaults | 12–10 | ok |
| defaults | 13–11 | ok |
| defaults | 13–10 | ALREADY_OVER (12–10 was final) |
| defaults | 15–3 | ALREADY_OVER |
| defaults | 11–0 | ok |
| sink = 3 | 13–10, winner has 1 sink | ok (10–10 before the sink) |
| sink = 3 | 13–10, winner has no sink | ALREADY_OVER |
| sink = 3 | 14–10, winner has 1 sink | ok (11–10 before the sink) |
| sink = 3 | 15–9, winner has 1 sink | ALREADY_OVER |
| sink ends game | winner 1 sink, 4–9 | ok (winner trailing) |
| sink ends game | winner 1 sink, 11–5 | SINK_AFTER_GAME_OVER |
| sink ends game | loser has a sink | LOSER_SINK_WHEN_SINK_ENDS |
| sink ends game | winner has 2 sinks | MULTIPLE_SINKS_WHEN_SINK_ENDS |
| sink ends game | no sinks, 11–9 | ok |
| sink ends game, sink = 3 | winner 1 sink, 12–9 | ok (9–9 before the sink) |
| target 7, win-by 1 | 7–6 | ok |
| target 7, win-by 1 | 8–6 | ALREADY_OVER |

**`checkStructure`**

- A duplicate player is an error.
- Three players on one side is an error.
- A negative value, 100, or 2.5 is an error.
- With a sink worth 3, a player with 1 sink and 2 points is an error.
- A missing winner is an error.

**`rankStandings`**

- Sorts by the configured primary metric.
- `head_to_head` breaks a two-way tie, uses only games among the tied group in a
  three-way tie, and is a no-op when the tied teams never played each other.
- Teams below `minGames` are unranked, and a team with 0 GP is always unranked.
- A full tie shares a rank.
- A custom order (`wins` first) changes the ranking.

**`pairKey`** is independent of argument order.

**`drafts.ts`** (Storage interface backed by an in-memory store):

- A draft survives a reload.
- The idempotency key is stable across retries.
- The draft clears after success, but not after failure.

### 5.2 API integration tests

**Auth**

- An unknown email gets `202` with the same body as a known one.
- The correct code creates a session; the database holds only the hash.
- The 5th wrong attempt invalidates the code.
- A code fails at TTL + 1 s.
- A code can't be reused.
- A new code invalidates the old one.
- The 6th code request in an hour gets `429`.
- Logout revokes the session.
- The web cookie is httpOnly, Secure, and SameSite=Lax.
- A cookie-authenticated write with a foreign or missing `Origin` gets `403`.
- A bearer token works for `client: 'native'`.
- Auth logs never contain the email, code, or token (captured logger output).

**Tenancy and membership**

- Joining by invite creates a pending membership. A pending member gets `404` on league
  data; after approval they get access.
- An expired or revoked invite is rejected.
- Display names are unique case-insensitively and after NFKC normalization.
- A table-driven test over **every** league route shows that a member of league X
  gets `404` for league Y's resources.
- A non-commissioner calling a commissioner route gets `403`.
- The last commissioner can't demote themselves or leave.

**Submit**

- A valid exhibition game opens a revision, with the submitter's confirmation recorded.
- A submitter who isn't one of the four gets `403`.
- A non-approved player gets `422`.
- A future `playedAt` gets `422`.
- A rules violation without an override request gets `422 RULES_VIOLATION` with the
  violation codes. With `requestOverride`, the game is stored with an override request
  and commissioners get an email.
- A retry with the same idempotency key returns the same game; no duplicate game and no
  duplicate email.
- The same key with a different payload gets `409`.
- `rules_snapshot` matches the league rules at submit time.

**Confirm**

- Three confirmations don't count. The fourth confirms the game, and the player stats
  reflect it.
- Confirming a superseded revision gets `409`.
- A non-player gets `403`.
- Confirming twice is idempotent.
- Concurrent final confirmations (`Promise.all`) produce exactly one transition, one
  audit/outbox effect, and stats counted once.

**Correct**

- A correction resets earlier confirmations, records the author's confirmation, and
  supersedes the prior revision.
- `window_expires_at` doesn't change.
- A stale `baseRevisionId` gets `409`.
- A correction is validated against the snapshot after the league rules have changed.
- A correction that violates the rules needs a new override (the old approval doesn't
  carry over).

**Reopen**

- While a correction is open, the old revision still counts. Once the new revision is
  confirmed, it replaces the old one in stats.
- If the open revision expires, the old one keeps counting.
- An exhibition game can be reopened up to the 30-day boundary but not past it.
- A season game can't be reopened after the season ends or is finalized.

**Expiry**

- A revision is still open 1 s before `window_expires_at` and expired exactly at it.
- Confirming after expiry gets `409`.
- Expiry applies with the worker stopped (lazy evaluation).
- A worker sweep marks the game expired, and an expired game never counts.

**Force-confirm**

- A commissioner force-confirming silent players confirms the game, with one audit event
  per player.
- A playing commissioner sets `actor_was_participant`.
- Force-confirming a player who already confirmed is a no-op.
- A non-commissioner gets `403`.
- Force-confirming an expired revision gets `409`.
- A correction after a force-confirm resets the confirmations.

**Override**

- Approving before the four confirmations works, and so does approving after them.
- After a rejection the revision can't be confirmed, but a correction within the window
  still works.
- Approved override games count fully in stats.

**Seasons and teams**

- The team flow works end to end: propose, accept, approve.
- A second team for the same player in the same season is rejected.
- Starting a second season while one is active is rejected.
- A season game requires two distinct approved teams in the active season.
- One sub per side is accepted and `is_sub` is derived by the server. Two subs on one
  side get `422`. A sub who is on a third team is accepted.
- Submitting after the season ends gets `409`. A game already open at the end can still
  be corrected and confirmed until its window closes.
- The season finalizes when the last open revision confirms or expires, and
  `standings_config` is locked afterwards.
- A mid-season roster edit leaves earlier games' credits unchanged.
- A sub's points go to the sub's season stats while the win or loss goes to the team.

**Rules changes**

- Editing the rules is audited.
- Open and confirmed games are not re-validated, and their stats don't change.

**Stats**

- An exhibition game appears in neither season nor all-time stats; it does appear in
  exhibition and combined.
- Partnership stats use the pair who actually played.
- Expired, voided, and rejected revisions never count.

**Deletion and removal**

- Deleting an account erases the email, sessions, and outbox rows, and voids open
  revisions. Confirmed games remain under "Deleted player #N".
- With `keepDisplayName`, the name stays on games and stays reserved.
- Signing up again with the same email creates a new, unlinked user.
- Removing a member voids their open revisions, keeps their confirmed games, and closes
  their roster row.

**Notifications**

- A new revision enqueues email only for the other opted-in players.
- Opting out is respected.
- The email body has no numbers or tokens.
- An SMTP failure doesn't fail the request, and the outbox retries with backoff.

**Hardening**

- A 17 KB body gets `413`.
- Extra unknown fields are rejected by the strict zod schemas.

### 5.3 E2E tests (Playwright against the Compose stack; codes read through Mailpit's HTTP API)

- **`season-flow.spec.ts`** (four browser contexts):
  1. The commissioner, created by the CLI, shares the invite; three players join and the
     commissioner approves them.
  2. Two teams form and get approved; the season starts.
  3. One player submits a game; the other three confirm it.
  4. Standings show the win, and player stats show the points and sinks.
  5. A player proposes a correction; the inbox badges appear and the old numbers still
     show until all four confirm the new revision.
- **`offline-retry.spec.ts`:**
  1. Go offline with `context.setOffline(true)`; the submit fails and the draft remains.
  2. Go back online and press Retry.
  3. Exactly one game exists.
- **`override.spec.ts`:** an 11–10 game shows the violation; "Submit for commissioner
  review" sends it to the commissioner, who approves it, and it counts once all four
  confirm.
- **`xss.spec.ts`:** a display name of `<img src=x onerror=alert(1)>` is rejected by
  validation; a name with an apostrophe (`O'Neil`) renders as text.

Expiry and windows are covered only by integration tests with the injected clock. The
E2E suite never sleeps or manipulates time.

## 6. Verification

The implementation must provide a single command, run from the repo root:

```bash
npm run verify
```

It runs these steps, in order, and fails on the first error:

1. `docker compose -f compose.yaml -f compose.test.yaml up -d --build --wait db mailpit migrate api worker web`
2. `npm run typecheck && npm run lint` across all workspaces.
3. `npm test`: core unit tests and API integration tests against the Compose Postgres.
4. `docker compose -f compose.yaml -f compose.test.yaml run --rm e2e`: all of §5.3.

It passes when all four steps exit 0 and the Playwright report lists `season-flow`,
`offline-retry`, `override`, and `xss` as passed.

**Manual smoke test**, for reviewers:

1. Bring the stack up and open `https://localhost`.
2. Sign in, reading the code at `http://localhost:8025` (Mailpit).
3. Record an exhibition game with three other test accounts and confirm it from each.
4. Check the Exhibition and Combined stats tabs: the game should count there and not in
   All-time.
