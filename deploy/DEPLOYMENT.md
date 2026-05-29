# Production deployment

Aimed at a single-host Linux deploy (Ubuntu / Debian / RHEL). For a fleet
or container deploy, the env vars + jobs translate directly; only the
process supervisor changes.

## 1. Host prerequisites

- **Node ≥ 20.6** (every script uses `--env-file-if-exists=.env`)
- **MySQL 8 or MariaDB 10.5+** reachable from the host
- A dedicated Unix user `religio` (no shell login needed)
- A writable log dir `/var/log/religio/` owned by `religio:religio`

```bash
sudo useradd --system --home /srv/religio-pro --shell /usr/sbin/nologin religio
sudo mkdir -p /srv/religio-pro /var/log/religio
sudo chown religio:religio /srv/religio-pro /var/log/religio
```

## 2. Deploy the app

```bash
sudo -u religio git clone https://github.com/galihsidik86/travel.git /srv/religio-pro
cd /srv/religio-pro
sudo -u religio npm ci --omit=dev
sudo -u religio npx prisma migrate deploy
sudo -u religio npx prisma generate
# Optional: only seed on a fresh DB
# sudo -u religio npm run db:seed
```

## 3. Configure `.env`

Copy `.env.example` → `.env` and fill:

| Var | Purpose | Required |
|-----|---------|----------|
| `DATABASE_URL` | Prisma connection string | yes |
| `JWT_SECRET` | min 32 chars random | yes |
| `COOKIE_SECURE` | `true` behind HTTPS | yes (prod) |
| `COOKIE_DOMAIN` | e.g. `religio.pro` | yes (prod) |
| `PORT` | default 3000 | optional |
| `NOTIF_WORKER_DISABLED` | `true` if cron/systemd drives notifs (recommended in prod — see step 5) | recommended |
| `REDIS_URL` | e.g. `redis://localhost:6379` — when set, rate-limiter uses Redis (multi-instance safe). Unset = in-memory (single-instance only). Fails open on Redis errors. | recommended for multi-instance |
| `MIDTRANS_SERVER_KEY` / `MIDTRANS_CLIENT_KEY` / `MIDTRANS_PRODUCTION` | gateway live mode | when Midtrans is live |
| `FONNTE_TOKEN` / `FONNTE_BASE_URL` | WA delivery (Indonesian provider) | when WA is live |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_SECURE` | email delivery | when email is live |
| `PUBLIC_BASE_URL` | absolute URL used in notification deep links | recommended |

Without `MIDTRANS_SERVER_KEY`, the gateway runs in fake mode (local
`/payments/midtrans/fake` handler simulates webhooks — fine for staging,
**do not deploy fake mode to production**).

Without `FONNTE_TOKEN` / `SMTP_HOST`, notif sender falls back to console
logger — notif rows still queue + dispatch (status SENT), but nothing
actually delivers. The boot banner logs `[notif] WA sender = Fonnte` /
`[notif] EMAIL sender = SMTP <host>` only when the credentials are
present, so a missing line tells you you're still on console.

## 4. Run the web server

### Option A — systemd

```bash
sudo cp deploy/systemd/religio-pro-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now religio-pro-web
```

The shipped unit runs `npm run start` as `religio`, sandboxes via
`ProtectSystem=strict` + `ProtectHome=true` + `PrivateTmp=true`, and grants
write access only to `/var/log/religio`, `private/`, and `uploads/`. Adjust
`ReadWritePaths=` if your `DATABASE_URL` or upload dir lives elsewhere.

### Option B — process manager (PM2 etc.)

Out of scope; any supervisor that runs `npm run start` as user `religio`
in `/srv/religio-pro` works.

## 5. Cron / systemd timer setup for jobs

Three jobs need to run on a schedule. Choose ONE of:

### Option A — systemd timers (preferred on modern hosts)

```bash
sudo cp deploy/systemd/religio-*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
  religio-expire-docs.timer \
  religio-expire-intents.timer \
  religio-send-notifications.timer

# Verify
systemctl list-timers 'religio-*'
```

### Option B — traditional cron

```bash
sudo cp deploy/crontab.example /etc/cron.d/religio-pro
sudo chmod 644 /etc/cron.d/religio-pro
sudo systemctl restart cron   # or `crond` on RHEL
```

**Set `NOTIF_WORKER_DISABLED=true` in `.env`** when using cron/systemd
for notifs — otherwise the in-process worker AND cron both dispatch, and
you'll see double-tick patterns in `notif.log`.

## 6. Database backups

Copy `deploy/backup.example.sh` → `/srv/religio-pro/deploy/backup.sh`,
make it executable, and let cron run it nightly (the cron entry is
already in `deploy/crontab.example`).

```bash
sudo cp deploy/backup.example.sh /srv/religio-pro/deploy/backup.sh
sudo chmod +x /srv/religio-pro/deploy/backup.sh
sudo install -d -o religio -g religio /var/backups/religio-pro
sudo -u religio /srv/religio-pro/deploy/backup.sh   # one-off verification
```

What it does: parses `DATABASE_URL` from `.env`, runs `mysqldump
--single-transaction` (consistent InnoDB snapshot, no write lock), gzips
the output to `/var/backups/religio-pro/<db>_<UTC-timestamp>.sql.gz`,
and prunes dumps older than 14 days (`RETAIN_DAYS` env var to override).

Off-host shipping (S3 / rsync to remote) is intentionally out of scope —
wrap the script if you need that; it prints the dump file path on stdout.

Restore (manual):

```bash
gunzip -c religio_pro_2026-05-29_18-15.sql.gz | mysql -u root -p religio_pro
```

## 7. Log rotation

```bash
sudo cp deploy/logrotate.example /etc/logrotate.d/religio-pro
# Test before letting cron run it
sudo logrotate --debug /etc/logrotate.d/religio-pro
```

## 8. Reverse proxy + TLS (Caddy/nginx)

Behind any TLS-terminating reverse proxy. The app listens on `127.0.0.1`
internally; proxy forwards `/*` to it. Ensure:
- `X-Forwarded-For` is set (Express `trust proxy 1` already configured
  in `src/app.js`)
- `X-Forwarded-Proto` is set so secure-cookie checks work
- WebSocket forwarding NOT required (no WS endpoints)

## 9. Verifying everything ran

Use the bundled pre-launch smoke runner — it hits a running instance
(no DB access), checks `/api/health`, CSRF cookie mint, sensitive-path
block, and bogus-login rejection. Add `SMOKE_USER`/`SMOKE_PASS` for an
authenticated probe.

```bash
node scripts/smoke-launch.js --base https://staging.religio.pro
SMOKE_USER=ops@religio.pro SMOKE_PASS=... \
SMOKE_PAKET_SLUG=ramadhan-aqsa-2026 \
  node scripts/smoke-launch.js --base https://religio.pro
```

Manual cross-checks:

```bash
# Web up?
curl -s http://localhost:3000/api/health | jq

# Most recent job runs
sudo journalctl -u 'religio-*' --since "1 hour ago" --no-pager
# OR for traditional cron:
sudo tail -50 /var/log/religio/*.log

# Notif queue depth — should drain quickly when jobs run
sudo -u religio npx prisma studio  # or query directly:
#   SELECT status, COUNT(*) FROM Notification GROUP BY status;
```

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Job log empty + timer "active (waiting)" | not yet triggered; `OnBootSec` defers first run | wait or `systemctl start religio-X.service` to force one |
| `Cannot find module` on first run | `npm ci` not run as `religio` user | re-run as religio |
| `PrismaClientInitializationError` | `DATABASE_URL` wrong / MariaDB not up | check `mariadb status`, test connection |
| Notif rows stuck PENDING | no sender wired + worker disabled | set `FONNTE_TOKEN` / `SMTP_HOST` OR enable in-process worker (`NOTIF_WORKER_DISABLED=false`) |
| Multiple deliveries per notif | both in-process worker AND cron running | set `NOTIF_WORKER_DISABLED=true` and restart |
| `EPERM rename query_engine` on `prisma generate` | dev `--watch` holds the DLL | stop server, regenerate, restart |
| Webhook signature failures (Midtrans) | wrong `MIDTRANS_SERVER_KEY` or production/sandbox mismatch | verify key in Midtrans dashboard matches `.env`; check `MIDTRANS_PRODUCTION` |

## 11. Updating the deploy

```bash
cd /srv/religio-pro
sudo -u religio git pull
sudo -u religio npm ci --omit=dev
sudo -u religio npx prisma migrate deploy
sudo -u religio npx prisma generate
sudo systemctl restart religio-pro-web
# timers auto-pick up the new code on next fire — no restart needed
```

## Future work

- **Mobile crew/jemaah apps** — `screens/crew-app.html` + `screens/jemaah-app.html`
  are still static mockups. SOS/chat from the crew mockup is the next
  deliberate follow-up.
- **Per-paket × per-agent komisi matrix** — currently the rate chain is
  per-agent OR per-paket. A `AgentPaketKomisi(agentId, paketId, rate)` join
  table would let "ahmad-w gets 15% on VVIP only" without code changes.
- **Server-side document thumbnails** — `/saya/profile` + `/admin/jemaah` doc
  panels render full images scaled by CSS. Fine at current 8 MB cap + typical
  per-jemaah doc counts; if it ever becomes a bottleneck, add `sharp`/`jimp`
  cached thumbs at `private/docs/<jemaahId>/thumbs/`.
