# Install guide

This guide covers two setups:

- **[Production](#production-on-one-server):** the whole app on one Linux server with
  Docker Compose, served over HTTPS.
- **[Local development](#local-development):** the API, worker, and web app running on
  your machine, with Postgres and a mail catcher in Docker.

Once the app is running, the [user guide](user-guide.md) explains how to use it.

## What runs

| Service | What it does |
| --- | --- |
| `db` | Postgres 18. All league data lives in the `db-data` volume. |
| `migrate` | Runs once on every `up`. It applies database migrations, then creates or updates the database logins that the API, worker, and backups use. |
| `api` | The HTTP API (Node 26). It listens on port 3000 inside Compose only. |
| `worker` | Sends queued email, closes games whose confirmation window has run out, and deletes expired sessions, sign-in codes, and old mail. |
| `web` | Caddy. It gets and renews the TLS certificate, serves the web app, and passes `/api` to the API. It is the only service with published ports (80 and 443). |
| `backup` | Dumps the database every night at 03:00 UTC into the `db-backups` volume and keeps 14 days of dumps. |
| `mailpit` | Development and tests only. It catches outgoing mail so you can read it in a browser. Production never starts it. |

## Production on one server

### Requirements

- A Linux server with Docker Engine and the Docker Compose plugin (`docker compose`).
  This guide was tested with Docker Compose v5.6.
- A domain name, with a DNS `A` record pointing at the server, plus an `AAAA` record if
  the server has IPv6.
- Ports 80 and 443 open to the internet: TCP for both, and UDP 443 too if you want HTTP/3.
  Caddy needs these ports to get its certificate automatically.
- An SMTP account that supports TLS. Sign-in codes go out by email, so nobody can sign in
  until mail works.
- `git`, and `openssl` to generate secrets.

The server doesn't need Node: everything runs in containers.

### 1. Get the code

```bash
git clone https://github.com/cypherbean-io/beer-die-league-web.git beer-die-league
cd beer-die-league
```

### 2. Create `.env`

Compose reads its settings from a file named `.env` in the same directory as
`compose.yaml`. Git ignores this file. Never commit it.

| Variable | What it is |
| --- | --- |
| `POSTGRES_PASSWORD` | The Postgres superuser's password. Only `migrate` uses it. Postgres reads it only when the database volume is first created; see [Changing secrets](#changing-secrets). |
| `APP_DB_PASSWORD` | The password for `beerdie_app`, the login the API and worker use. This login can't change or delete audit-log entries. At least 16 characters. |
| `BACKUP_DB_PASSWORD` | The password for `beerdie_backup`, the read-only login that backups use. At least 16 characters. |
| `AUTH_SECRET` | The key for sign-in codes, rate limits, and the codes waiting in the outbox. At least 32 characters. |
| `APP_ORIGIN` | The app's public address, such as `https://league.example.com`, with no trailing slash or path. Caddy gets its certificate for this address. Links in emails and invite links use it, and the API refuses browser writes that come from any other origin. |
| `SMTP_URL` | The outgoing mail server, which must use TLS: `smtps://USER:PASSWORD@smtp.example.com:465`, or `smtp://USER:PASSWORD@smtp.example.com:587?requireTLS=true`. Percent-encode any special characters in the user name and password (for example, `@` becomes `%40`). |
| `MAIL_FROM` | The From header on every email, such as `Beer Die League <no-reply@league.example.com>`. Use an address your mail provider lets you send from. |

The passwords go into database connection URLs, so they must be URL-safe. The command
below writes `.env` with random hex values for the passwords and the secret. The file is
readable by you only, and the values never appear on screen:

```bash
(umask 077; cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
APP_DB_PASSWORD=$(openssl rand -hex 32)
BACKUP_DB_PASSWORD=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
APP_ORIGIN=https://league.example.com
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465
MAIL_FROM=Beer Die League <no-reply@league.example.com>
EOF
)
```

Then edit `.env` and replace the last three values with your own. Keep a copy of the
finished file somewhere safe, such as a password manager.

### 3. Start the stack

```bash
docker compose -f compose.yaml up -d --build --wait
```

In production, always pass `-f compose.yaml`. A bare `docker compose` also loads
`compose.override.yaml`, which holds the development settings: it turns off database
passwords and runs `migrate` from the checkout.

This command:

1. Builds three images: `api` (also used for the worker, `migrate`, and the CLI), `web`,
   and `backup`. The first build takes a while.
2. Starts Postgres and runs `migrate`.
3. Starts the API, the worker, and the backup service.
4. Starts Caddy once the API is healthy. Caddy then gets a certificate for `APP_ORIGIN`.

`--wait` returns once every service is healthy. Caddy counts as healthy only after its
certificate is in place. If DNS or the ports aren't set up yet, `--wait` fails after about
a minute; see [Troubleshooting](#troubleshooting).

To check the result:

```bash
docker compose -f compose.yaml ps
curl https://league.example.com/api/health
```

The health check answers `{"status":"ok"}`.

### 4. Create the league

The app has no page for creating a league. Instead, create the league and its first
commissioner from the command line:

```bash
docker compose -f compose.yaml exec api node src/cli.ts create-league \
  --name "Basement League" \
  --commissioner-email you@example.com \
  --display-name "Alex"
```

The command prints the new ids, and only the ids:

```json
{"leagueId":"01a16944-bcc2-7351-8f25-c6d4e6890124","membershipId":"01a16944-bcc4-71b0-91f4-dc79f9f918dd"}
```

Keep the `leagueId`, because
[recovering a league](#recover-a-league-with-no-commissioner) needs it.

- A league name can be 1 to 60 characters long.
- A display name must follow the rules in the
  [user guide](user-guide.md#joining-a-league).
- Put quotes around any value that contains spaces.

The web app shows each person a single league, so create one league per deployment.

### 5. Sign in

1. Open your `APP_ORIGIN` in a browser.
2. Enter the commissioner email and type in the 6-digit code that arrives by email.
3. On Home, choose **Invite players** to create an invite link, then share it.

The [commissioner section of the user guide](user-guide.md#for-commissioners) covers the
rest.

### Updating

```bash
git pull
docker compose -f compose.yaml up -d --build --wait
```

This rebuilds the images and runs `migrate` again, which applies any new migrations. It
then replaces only the containers that changed. If you want a point to roll back to,
[take a backup](#backups) first.

### Day-to-day operations

Run these commands from the checkout.

| Task | Command |
| --- | --- |
| See what's running | `docker compose -f compose.yaml ps` |
| Follow the logs | `docker compose -f compose.yaml logs -f api worker web` |
| Stop everything | `docker compose -f compose.yaml stop` |
| Start again | `docker compose -f compose.yaml up -d --wait` |
| Open a database shell | `docker compose -f compose.yaml exec db psql -U postgres beerdie` |

Logs are JSON lines. Docker rotates them and keeps five 10 MB files per container. Logs
never contain email addresses, display names, sign-in codes, or tokens, and Caddy keeps no
access log.

Never run `docker compose -f compose.yaml down -v`. The `-v` flag deletes the volumes,
which hold the database, the backups, and the certificates. `down` without `-v` is safe.

### Backups

Every night at 03:00 UTC, the `backup` service dumps the database in `pg_dump`'s custom
format. Each dump is saved as `beerdie-<UTC timestamp>.dump` in the `db-backups` volume.

Each run also deletes dumps more than 13 days old, so no dump lives past 14 days. The
app's privacy note promises that deleted data is gone from backups within 14 days, so
this pruning runs even when the dump itself fails.

The backups sit on the same server as the database, so copy them somewhere else
regularly. To keep the 14-day promise, delete those copies after 14 days too.

Check that backups are running. A failed run logs
`{"level":"error","msg":"backup failed"}`:

```bash
docker compose -f compose.yaml logs backup
```

Take a backup now:

```bash
docker compose -f compose.yaml exec backup /ops/backup.sh once
```

List the backups:

```bash
docker compose -f compose.yaml exec backup ls -l /backups
```

Copy a backup out of the volume into the current directory:

```bash
docker compose -f compose.yaml cp backup:/backups/beerdie-20261023T030000Z.dump .
```

A dump holds personal data, including email addresses and display names. The copy is
readable by you only, so keep it that way.

### Restore a backup

Restoring replaces everything in the database with the contents of the dump. Anything
recorded after the dump was taken is lost, and anyone who signed in after that has to sign
in again.

1. Put the dump in the checkout directory on the server. If it's still in the backup
   volume, copy it out as shown above.
2. Stop the services that write to the database:

   ```bash
   docker compose -f compose.yaml stop api worker backup
   ```

3. Copy the dump into the database container, restore it, and remove the copy:

   ```bash
   docker compose -f compose.yaml cp beerdie-20261023T030000Z.dump db:/tmp/restore.dump
   docker compose -f compose.yaml exec db pg_restore -U postgres -d beerdie \
     --clean --if-exists --single-transaction /tmp/restore.dump
   docker compose -f compose.yaml exec db rm /tmp/restore.dump
   ```

   `--single-transaction` means that a restore that fails changes nothing.

4. Start everything again:

   ```bash
   docker compose -f compose.yaml up -d --wait
   ```

   This runs `migrate`, which applies any migrations newer than the dump and gives the
   API and the backups their database permissions again.

### Move to a new server

On the old server:

1. Stop changes:

   ```bash
   docker compose -f compose.yaml stop web api worker
   ```

2. [Take a backup](#backups), copy it out of the volume, and transfer it to the new
   server (with `scp`, for example).

On the new server:

1. Follow [steps 1 and 2](#1-get-the-code) of the install. If you copy the old `.env`
   across, everything stays as it was. If you use new values instead, only sign-in codes
   that were in flight stop working.
2. Start everything except Caddy:

   ```bash
   docker compose -f compose.yaml up -d --build --wait db migrate api worker backup
   ```

3. Follow steps 2 and 3 of [Restore a backup](#restore-a-backup).
4. Point DNS at the new server. Once the new address resolves, start everything,
   including Caddy, which then gets its certificate:

   ```bash
   docker compose -f compose.yaml up -d --wait
   ```

### Recover a league with no commissioner

If every commissioner has left the league or deleted their account, make an approved
member a commissioner:

```bash
docker compose -f compose.yaml exec api node src/cli.ts promote-commissioner \
  --league-id 01a16944-bcc2-7351-8f25-c6d4e6890124 \
  --email member@example.com
```

On success, it prints `{"membershipId":"…"}`. If the email doesn't belong to an approved
member of that league, it prints `No approved membership in that league has that email.`
and exits with status 1.

If you've lost the league id, look it up:

```bash
docker compose -f compose.yaml exec db psql -U postgres beerdie -c 'select id, name from leagues'
```

### Changing secrets

Edit `.env`, then run `docker compose -f compose.yaml up -d --wait`. Compose recreates
every container that uses a changed value.

- **`AUTH_SECRET`:** sign-in codes that were already sent stop working. People who are
  signed in stay signed in.
- **`APP_DB_PASSWORD` or `BACKUP_DB_PASSWORD`:** `migrate` sets the new password before
  the API, worker, and backups restart with it.
- **`POSTGRES_PASSWORD`:** Postgres reads this only when the database volume is first
  created. If you change it in `.env` alone, `migrate` can no longer connect. To change
  it, open a database shell (see
  [Day-to-day operations](#day-to-day-operations)) and run `\password postgres`. Then
  put the same value in `.env`.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `up --wait` fails because `web` is unhealthy. | Caddy couldn't get a certificate. Read `docker compose -f compose.yaml logs web`. DNS must point at this server, and ports 80 and 443 must be reachable from the internet. Once that's fixed, run `up -d --wait` again. |
| `up` reports that port 80 or 443 is already allocated. | Another web server on this machine holds the port. Stop it. |
| `db` keeps restarting, and its log says the superuser password is not specified. | `POSTGRES_PASSWORD` is missing from `.env`. |
| `api` or `worker` keeps restarting with `Invalid or missing environment variables`. | The message names each bad variable and the rule it broke, such as an `AUTH_SECRET` under 32 characters or an `SMTP_URL` without TLS. Fix `.env`, then run `up -d --wait` again. |
| `migrate` logs `role provisioning failed`. | `APP_DB_PASSWORD` or `BACKUP_DB_PASSWORD` is missing or shorter than 16 characters. |
| `migrate` fails with `password authentication failed`. | `POSTGRES_PASSWORD` in `.env` no longer matches the database. See [Changing secrets](#changing-secrets). |
| No sign-in emails arrive. | `docker compose -f compose.yaml logs worker` shows mail errors as the provider's error codes. Check `SMTP_URL`, and check that your provider accepts the `MAIL_FROM` address. |

## Local development

### Requirements

- Node.js 26 or later, with npm.
- Docker with the Compose plugin.
- Ports 3000, 5432, 8081, 1025, and 8025 free on localhost.

### First run

```bash
npm install
docker compose up -d --wait db mailpit
docker compose run --rm migrate
DATABASE_URL=postgres://postgres@127.0.0.1:5432/beerdie npm run cli -w apps/api -- \
  create-league --name "Dev League" --commissioner-email you@example.com --display-name "Alex"
npm run dev
```

Here a bare `docker compose` is right. It loads `compose.override.yaml`, which runs
Postgres without passwords on `127.0.0.1:5432` and runs `migrate` straight from the
checkout, so new migrations apply without rebuilding an image.

`npm run dev` starts three things:

- The API on port 3000.
- The worker.
- The Expo web dev server on <http://localhost:8081>, which passes `/api` to the API.

To sign in:

1. Open <http://localhost:8081> and enter the commissioner email.
2. Find the code in Mailpit at <http://localhost:8025>. The worker delivers it within a
   few seconds.

Mailpit catches all mail, so any made-up address works for extra players. A browser holds
one session at a time, so use a private window or a separate browser profile for each
extra player.

### Configuration

`npm run dev` doesn't need a `.env` file. `scripts/local-env.ts` supplies these defaults,
and a variable that's already set in your environment overrides its default:

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/beerdie` |
| `APP_ORIGIN` | `http://localhost:8081` |
| `SMTP_URL` | `smtp://127.0.0.1:1025` (Mailpit) |
| `MAIL_FROM` | `Beer Die League <no-reply@beerdie.localhost>` |
| `AUTH_SECRET` | A new random value every time `npm run dev` starts |

Because `AUTH_SECRET` changes on each start, restarting `npm run dev` makes any unused
sign-in codes stop working. Request a new code.

### Database changes

After you edit `apps/api/src/db/schema.ts`:

1. Run `npx drizzle-kit generate` in `apps/api`.
2. Commit the generated SQL.
3. Apply it with `docker compose run --rm migrate`.

### Checks

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Lint and formatting | `npm run lint` (`npm run format` fixes formatting) |
| Unit and integration tests (needs `db` running) | `npm test` |
| One test file | `npx vitest run path/to/file.test.ts` |
| Everything, including stack tests and E2E | `npm run verify` |

### Run the whole stack locally

To try the production images on your machine, use the test variant of the stack. It adds
Mailpit and serves the app at `https://localhost`:

```bash
npm run stack -- build
npm run stack -- up -d --wait db mailpit migrate api worker web
npm run stack -- exec api node src/cli.ts create-league \
  --name "Stack League" --commissioner-email you@example.com --display-name "Alex"
```

- Open <https://localhost>. Caddy uses a certificate from its own local authority, so the
  browser shows a warning; accept it.
- Mail goes to Mailpit at <http://localhost:8025>.
- `npm run stack` supplies new throwaway secrets on every run, so bring the API and the
  worker up in the same command.
- This stack shares its Postgres with `npm run dev` and `npm test`.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `migrate` fails with `getaddrinfo ENOTFOUND db`. | Your existing containers predate the Compose network's IPv6 setting. Run `docker compose up -d --force-recreate --wait db mailpit` once. |
| No sign-in code shows up in Mailpit. | The worker sends mail, and `npm run dev` starts it. Check the `npm run dev` output for errors. |
| Home says "API unreachable". | The API isn't running. Check the `npm run dev` output. |
