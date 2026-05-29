#!/usr/bin/env bash
# Religio Pro — MySQL backup recipe.
#
# Idempotent nightly dump of the application database, rotated weekly.
# Drop in /srv/religio-pro/deploy/backup.sh on the host, mark executable,
# and add the cron line at the bottom of this file to /etc/cron.d/religio-pro.
#
# Assumptions:
#   - DATABASE_URL is set in /srv/religio-pro/.env in the form
#     mysql://user:pass@host:port/dbname
#   - /var/backups/religio-pro/ exists and is writable by user `religio`
#   - retention defaults to 14 days; tweak RETAIN_DAYS to taste
#
# What it does NOT do:
#   - off-host shipping (S3/rsync). Wrap this script if you need that —
#     the dump file path is printed on stdout so a wrapper can pick it up.
#
# Restore (manual):
#   gunzip -c religio_pro_YYYY-MM-DD_HH-MM.sql.gz | mysql -u root -p religio_pro

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/srv/religio-pro}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/religio-pro}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

# ── Parse DATABASE_URL from .env ───────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "backup: $ENV_FILE not found" >&2
  exit 1
fi

# Pull the DATABASE_URL line (last occurrence wins), strip quotes
DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | sed -E 's/^DATABASE_URL="?([^"]+)"?$/\1/')
if [[ -z "$DB_URL" ]]; then
  echo "backup: DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

# mysql://user:pass@host:port/dbname → parse via shell parameter expansion
proto_removed="${DB_URL#mysql://}"
userpass="${proto_removed%%@*}"
hostpart="${proto_removed#*@}"
DB_USER="${userpass%%:*}"
DB_PASS="${userpass#*:}"
hostport="${hostpart%%/*}"
DB_NAME="${hostpart#*/}"
DB_NAME="${DB_NAME%%\?*}"  # strip any ?param=... suffix
DB_HOST="${hostport%%:*}"
DB_PORT="${hostport#*:}"
[[ "$DB_PORT" == "$DB_HOST" ]] && DB_PORT=3306

# ── Dump ───────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y-%m-%d_%H-%M)
OUT="$BACKUP_DIR/${DB_NAME}_${TS}.sql.gz"

# --single-transaction: consistent snapshot for InnoDB without locking
# --routines / --triggers / --events: include stored programs
# --set-gtid-purged=OFF: MariaDB compatibility
MYSQL_PWD="$DB_PASS" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --quick \
  "$DB_NAME" | gzip -c > "$OUT"

echo "$OUT"

# ── Rotate ─────────────────────────────────────────────────────
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime "+$RETAIN_DAYS" -delete

# ── Cron line (install separately, do not paste this whole file into cron) ──
# 15 1 * * *  religio  /srv/religio-pro/deploy/backup.sh >> /var/log/religio/backup.log 2>&1
