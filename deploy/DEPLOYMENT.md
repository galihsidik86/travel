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
# (web unit not yet shipped — see "TODO" below for a minimal example)
sudo systemctl daemon-reload
sudo systemctl enable --now religio-pro-web
```

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

## 6. Log rotation

```bash
sudo cp deploy/logrotate.example /etc/logrotate.d/religio-pro
# Test before letting cron run it
sudo logrotate --debug /etc/logrotate.d/religio-pro
```

## 7. Reverse proxy + TLS (Caddy/nginx)

Behind any TLS-terminating reverse proxy. The app listens on `127.0.0.1`
internally; proxy forwards `/*` to it. Ensure:
- `X-Forwarded-For` is set (Express `trust proxy 1` already configured
  in `src/app.js`)
- `X-Forwarded-Proto` is set so secure-cookie checks work
- WebSocket forwarding NOT required (no WS endpoints)

## 8. Verifying everything ran

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

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Job log empty + timer "active (waiting)" | not yet triggered; `OnBootSec` defers first run | wait or `systemctl start religio-X.service` to force one |
| `Cannot find module` on first run | `npm ci` not run as `religio` user | re-run as religio |
| `PrismaClientInitializationError` | `DATABASE_URL` wrong / MariaDB not up | check `mariadb status`, test connection |
| Notif rows stuck PENDING | no sender wired + worker disabled | set `FONNTE_TOKEN` / `SMTP_HOST` OR enable in-process worker (`NOTIF_WORKER_DISABLED=false`) |
| Multiple deliveries per notif | both in-process worker AND cron running | set `NOTIF_WORKER_DISABLED=true` and restart |
| `EPERM rename query_engine` on `prisma generate` | dev `--watch` holds the DLL | stop server, regenerate, restart |
| Webhook signature failures (Midtrans) | wrong `MIDTRANS_SERVER_KEY` or production/sandbox mismatch | verify key in Midtrans dashboard matches `.env`; check `MIDTRANS_PRODUCTION` |

## 10. Updating the deploy

```bash
cd /srv/religio-pro
sudo -u religio git pull
sudo -u religio npm ci --omit=dev
sudo -u religio npx prisma migrate deploy
sudo -u religio npx prisma generate
sudo systemctl restart religio-pro-web
# timers auto-pick up the new code on next fire — no restart needed
```

## TODO (not yet shipped)

- **Web `.service` unit** for systemd — sample below; adapt to your supervisor:

```ini
[Unit]
Description=Religio Pro web server
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
Type=simple
User=religio
WorkingDirectory=/srv/religio-pro
EnvironmentFile=/srv/religio-pro/.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/religio/web.log
StandardError=append:/var/log/religio/web.log

[Install]
WantedBy=multi-user.target
```

- Health-endpoint extension surfacing **last-successful-run timestamp per job** for external uptime alerting
- Redis-backed rate limit (currently in-memory — multi-instance unsafe)
