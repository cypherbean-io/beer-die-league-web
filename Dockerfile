# syntax=docker/dockerfile:1
# Images for compose.yaml:
#   api     the API; also the worker, migrate, and the operator CLI
#   web     Caddy serving the exported web app (see Caddyfile)
#   backup  pg_dump on a nightly schedule (see ops/backup.sh)

FROM node:26-alpine AS workspace
WORKDIR /app
# npm ci checks every workspace against the lockfile, so all their manifests come first.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/app/package.json apps/app/

FROM workspace AS api-deps
# None of the API's runtime dependencies has an install script.
RUN npm ci --omit=dev --workspace apps/api --ignore-scripts

FROM node:26-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps /app/node_modules node_modules
# Node strips types itself. @beer-die/core resolves through a symlink to packages/core, outside
# node_modules, where Node allows that.
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
WORKDIR /app/apps/api
USER node
CMD ["node", "src/index.ts"]

FROM workspace AS web-build
ENV CI=1 EXPO_NO_TELEMETRY=1
RUN npm ci --workspace apps/app
COPY packages/core/src packages/core/src
COPY apps/app apps/app
RUN npm run build -w apps/app

FROM caddy:2.11-alpine AS web
# Runs unprivileged. compose.yaml lets it bind 80 and 443 with a sysctl, and drops every
# capability, so the binary's own file capability goes too: the kernel won't exec it otherwise.
RUN setcap -r /usr/bin/caddy \
  && addgroup -S caddy && adduser -S -G caddy caddy && chown -R caddy:caddy /data /config
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/app/dist /srv
USER caddy

FROM postgres:18-alpine AS backup
COPY --chmod=755 ops/backup.sh /ops/backup.sh
# Dumps hold PII: only the postgres user can read the directory.
RUN install -d -o postgres -g postgres -m 700 /backups
USER postgres
ENTRYPOINT ["/ops/backup.sh"]
CMD ["nightly"]
