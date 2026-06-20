#!/bin/bash
# Religio Pro — Domainesia VPS install script (Ubuntu 22.04 single-host).
#
# Usage (as root):
#   wget https://raw.githubusercontent.com/galihsidik86/travel/main/deploy/install.sh
#   chmod +x install.sh
#   DOMAIN=religio.sosmartpro.com DB_PASSWORD=<strong-pw> ./install.sh
#
# What it does:
#   1. Update apt + install Node 20, MariaDB, Caddy, git, curl, certbot
#   2. Create `religio` system user + /opt/religio-pro/ deploy root
#   3. Clone repo, install deps, run migrations
#   4. Create MariaDB user + database
#   5. Install systemd unit for the web process
#   6. Install /etc/cron.d/religio-pro
#   7. Install Caddyfile + reload Caddy (auto-issues Let's Encrypt cert)
#   8. Run prod:check + start web service
#
# Idempotent: re-running is safe (uses `--needed` / `if [ -d ... ]` guards).
# Re-run after a `git pull` to re-build + migrate + restart.

set -euo pipefail

DOMAIN="${DOMAIN:-religio.sosmartpro.com}"
DEPLOY_USER="${DEPLOY_USER:-religio}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/religio-pro}"
REPO_URL="${REPO_URL:-https://github.com/galihsidik86/travel.git}"
DB_NAME="${DB_NAME:-religio_pro}"
DB_USER="${DB_USER:-religio_admin}"
DB_PASSWORD="${DB_PASSWORD:-}"

if [[ -z "$DB_PASSWORD" ]]; then
  echo "ERROR: DB_PASSWORD env var required"
  echo "       Generate with: openssl rand -base64 24"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: must run as root (sudo)"
  exit 1
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!${NC} $*"; }
err()  { echo -e "${RED}xx${NC} $*"; }

# ── 1. System packages ─────────────────────────────────────────
log "1/8 — apt update + install base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg lsb-release ufw

# Node.js 20 LTS via NodeSource
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20.* ]]; then
  log "1a/8 — install Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
log "    node: $(node -v) / npm: $(npm -v)"

# MariaDB
if ! command -v mariadb >/dev/null 2>&1; then
  log "1b/8 — install MariaDB"
  apt-get install -y -qq mariadb-server mariadb-client
  systemctl enable --now mariadb
fi

# Caddy via official repo
if ! command -v caddy >/dev/null 2>&1; then
  log "1c/8 — install Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# Firewall
log "1d/8 — UFW firewall (SSH + HTTP + HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ── 2. Deploy user + dirs ──────────────────────────────────────
log "2/8 — create deploy user + dirs"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --home "$DEPLOY_ROOT" --shell /usr/sbin/nologin "$DEPLOY_USER"
fi
mkdir -p "$DEPLOY_ROOT" /var/log/religio /var/backups/religio-pro
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_ROOT" /var/log/religio /var/backups/religio-pro
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy

# ── 3. Clone repo + install deps ───────────────────────────────
log "3/8 — clone/pull repo"
if [[ -d "$DEPLOY_ROOT/.git" ]]; then
  sudo -u "$DEPLOY_USER" git -C "$DEPLOY_ROOT" pull --ff-only
else
  sudo -u "$DEPLOY_USER" git clone "$REPO_URL" "$DEPLOY_ROOT"
fi
log "    on commit: $(sudo -u "$DEPLOY_USER" git -C "$DEPLOY_ROOT" log --oneline -1)"

log "3b/8 — npm ci --omit=dev"
sudo -u "$DEPLOY_USER" bash -c "cd $DEPLOY_ROOT && npm ci --omit=dev"

# ── 4. MariaDB user + database ─────────────────────────────────
log "4/8 — MariaDB user + database"
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# ── 5. .env file ───────────────────────────────────────────────
log "5/8 — .env (from template if missing)"
if [[ ! -f "$DEPLOY_ROOT/.env" ]]; then
  cp "$DEPLOY_ROOT/deploy/.env.production.template" "$DEPLOY_ROOT/.env"
  # Substitute DB password placeholder
  sed -i "s|\[FILL_DB_PASSWORD\]|$DB_PASSWORD|g" "$DEPLOY_ROOT/.env"
  chmod 600 "$DEPLOY_ROOT/.env"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_ROOT/.env"
  warn "    Created $DEPLOY_ROOT/.env with DB password injected."
  warn "    EDIT IT to fill 3rd-party tokens (Fonnte, SMTP, Midtrans, admin contacts):"
  warn "      nano $DEPLOY_ROOT/.env"
else
  log "    $DEPLOY_ROOT/.env exists (skipped) — edit manually if needed"
fi

# ── 6. Prisma migrate + generate + seed ────────────────────────
log "6/8 — Prisma migrate + generate"
sudo -u "$DEPLOY_USER" bash -c "cd $DEPLOY_ROOT && npx prisma migrate deploy && npx prisma generate"
if [[ "${SEED:-no}" == "yes" ]]; then
  log "6b/8 — seed demo data"
  sudo -u "$DEPLOY_USER" bash -c "cd $DEPLOY_ROOT && npm run db:seed"
  warn "    Seeded demo accounts — CHANGE PASSWORDS via /admin before going live"
else
  log "    SEED=yes to seed demo accounts on first run (default: skip)"
fi

# ── 7. systemd web unit ────────────────────────────────────────
log "7/8 — systemd web unit"
cat > /etc/systemd/system/religio-pro-web.service <<EOF
[Unit]
Description=Religio Pro web server
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=$DEPLOY_USER
WorkingDirectory=$DEPLOY_ROOT
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/religio/web.log
StandardError=append:/var/log/religio/web.log

# Security sandboxing
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=$DEPLOY_ROOT/private $DEPLOY_ROOT/uploads /var/log/religio

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now religio-pro-web

# ── 8. Cron + Caddyfile ────────────────────────────────────────
log "8a/8 — cron jobs"
sed "s|/srv/religio-pro|$DEPLOY_ROOT|g; s|religio  |$DEPLOY_USER  |g" "$DEPLOY_ROOT/deploy/crontab.example" > /etc/cron.d/religio-pro
chmod 644 /etc/cron.d/religio-pro
systemctl restart cron

log "8b/8 — backup script"
cp "$DEPLOY_ROOT/deploy/backup.example.sh" "$DEPLOY_ROOT/deploy/backup.sh"
chmod +x "$DEPLOY_ROOT/deploy/backup.sh"
chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_ROOT/deploy/backup.sh"

log "8c/8 — Caddyfile"
sed "s|religio.sosmartpro.com|$DOMAIN|g" "$DEPLOY_ROOT/deploy/Caddyfile.example" > /etc/caddy/Caddyfile
systemctl reload caddy

# ── Final: prod:check + status ─────────────────────────────────
log "==> Pre-flight readiness check"
sudo -u "$DEPLOY_USER" bash -c "cd $DEPLOY_ROOT && NODE_ENV=production npm run prod:check" || true

log "==> systemd status"
systemctl status religio-pro-web --no-pager -l | head -15 || true

log ""
log "──────────────────────────────────────────────────────────────"
log "Install complete. Next:"
log ""
log "  1. Edit $DEPLOY_ROOT/.env to fill optional 3rd-party tokens:"
log "       nano $DEPLOY_ROOT/.env"
log "     Then restart: systemctl restart religio-pro-web"
log ""
log "  2. Verify DNS + Caddy SSL:"
log "       curl -I https://$DOMAIN"
log "     Expect: HTTP/2 302 (redirect to /login)"
log ""
log "  3. Health endpoint:"
log "       curl -s https://$DOMAIN/api/health | python3 -m json.tool"
log ""
log "  4. Tail logs:"
log "       journalctl -u religio-pro-web -f"
log "       tail -f /var/log/religio/*.log"
log ""
log "  5. First admin login (if seeded):"
log "       https://$DOMAIN/login"
log "       owner@religio.pro / owner12345 — CHANGE PASSWORD IMMEDIATELY"
log "──────────────────────────────────────────────────────────────"
