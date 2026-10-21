#!/bin/sh
# Dumps the league database and keeps 14 days of dumps. They hold PII, so deleted data
# lingers in them for no longer than that (SPEC §4). Runs in the `backup` image, which has
# pg_dump; the PG* variables in compose.yaml say where to connect.
#   backup.sh once      take one dump now
#   backup.sh nightly   take one at 03:00 UTC every day (the compose service's default)
set -eu

BACKUP_DIR=/backups
RETENTION_MINUTES=$((14 * 24 * 60))
RUN_AT=03:00:00

log() {
  printf '{"level":"%s","msg":"%s"}\n' "$1" "$2"
}

once() {
  umask 077
  # First, so the 14 days hold even through a run of failed dumps (the privacy note promises
  # them). Partial dumps count too: a run killed mid-dump (a container stop) leaves one.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'beerdie-*.dump' -o -name '.beerdie-*.dump.partial' \) \
    -mmin +"$RETENTION_MINUTES" -delete
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  partial="$BACKUP_DIR/.beerdie-$stamp.dump.partial"
  trap 'rm -f "$partial"' EXIT
  pg_dump --format=custom --file="$partial"
  mv "$partial" "$BACKUP_DIR/beerdie-$stamp.dump"
  log info 'backup written'
}

seconds_until_next_run() {
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $RUN_AT" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

case "${1:-}" in
  once)
    once
    ;;
  nightly)
    while :; do
      sleep "$(seconds_until_next_run)"
      # A child process, so `set -e` still holds inside it and one failure doesn't stop the loop.
      "$0" once || log error 'backup failed'
    done
    ;;
  *)
    echo "usage: $0 once|nightly" >&2
    exit 2
    ;;
esac
