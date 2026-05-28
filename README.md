# Religio Pro

End-to-end management system for Indonesian umrah & haji travel agencies —
public package landing, agent CRM, jemaah self-service portal, crew
(muthawwif) portal, admin/HQ dashboard, full money flow (payment gateway,
refunds, agent commissions, payouts), notification queue, and ops jobs.

All copy is **Bahasa Indonesia** (`lang="id"`).

> 🤖 Built by Claude Sonnet 4.6 (claude.ai/code) — vertical-slice
> development across the schema, services, routes, EJS views, and a
> 241-test [node:test](https://nodejs.org/api/test.html) suite.

---

## Stack

- **Runtime:** Node ≥ 20.6 (uses `--env-file-if-exists=.env`)
- **Web:** Express 4 + EJS templates
- **DB:** MySQL 8 / MariaDB 10.5+ via Prisma 6 (cuid IDs, decimal money)
- **Auth:** stateless JWT (HS256) in `httpOnly` cookie + bearer
- **Tests:** built-in `node:test` (zero deps), 241 tests in `tests/`
- **No frontend framework** — server-rendered HTML + tiny vanilla JS
  per page. Shared design tokens in `shared/tokens.css`.
- **Pluggable adapters:**
  - WA via **Fonnte** (env-gated), Email via **nodemailer/SMTP**
  - Payment gateway: **Midtrans Snap** (sandbox or production)
  - Rate-limit store: in-memory (default) or **Redis** (`REDIS_URL` env)

---

## Quickstart

Requires Node ≥ 20.6 and a running MySQL/MariaDB.

```bash
git clone https://github.com/galihsidik86/travel.git religio-pro
cd religio-pro
npm install
cp .env.example .env       # then edit DATABASE_URL + JWT_SECRET (≥32 chars)
npm run db:migrate
npm run db:seed             # owner + kasir + agent + 1 demo paket
npm run dev                 # http://localhost:3001 (port from .env)
```

### Default seeded credentials

| Role  | Email                | Password    |
|-------|----------------------|-------------|
| OWNER | `owner@religio.pro`  | `owner12345`|
| KASIR | `kasir@religio.pro`  | `kasir12345`|
| AGEN  | `ahmad@religio.pro`  | `ahmad12345`|

Browse:
- `/` — design system hub (in-tile previews of every screen)
- `/p/ramadhan-aqsa-2026?a=ahmad-w` — public paket landing (agent lock-in)
- `/login` → role-based redirect:
  - `OWNER/SUPERADMIN/MANAJER_OPS/KASIR` → `/admin`
  - `AGEN` → `/agen`
  - `MUTHAWWIF` → `/crew`
  - `JEMAAH` → `/saya`

### Tests

```bash
npm test                    # 241 tests, ~21s serialised
npm run test:watch          # re-runs on file change
```

Test files in `tests/` use the shared `_helpers.js` fixtures
(`tempJemaah`, `tempPaket`, `tempBooking`, …) which clean up via
`t.after()`. Serialised execution (`--test-concurrency=1`) avoids
MariaDB FK-cascade deadlocks against the shared dev DB.

---

## Feature overview

The build is staged. Each stage is a self-contained vertical slice
(schema migration → service → routes → views → tests).

1. **Skeleton** — Express + static design serving + sensitive-path block
2. **Schema + seed** — Prisma 6 + MariaDB, 8-role RBAC enum, seeded
   demo data (owner, kasir, agent `ahmad-w`, paket `ramadhan-aqsa-2026`,
   5 demo bookings, 6 demo leads, 12 rooms)
3. **Auth + RBAC** — JWT cookie + bearer, login rate-limit (10/min/IP),
   anti-escalation (SUPERADMIN can't manage OWNER), append-only audit
4. **Public paket landing** — `/p/:slug?a=<agent>`, agent lock-in via
   `agentSlugCap` snapshot (immutable URL-of-origin trail)
5. **Agen portal** `/agen` — Leads kanban (Cold/Warm/Hot/Lunas),
   marketing kit links, komisi wallet, analytics funnel
6. **Admin dashboard** `/admin` — Overview/Paket/Manifest/Bunking/Finance
   tabs, Users + Jemaah + Audit + Booking-detail sub-pages
7. **Money flow** — Payment recording, status transitions, auto-Komisi
   on LUNAS, cancel + refund (negative-Payment append-only)
8. **Ops jobs** — daily `expire-docs`, every-10-min `expire-intents`,
   every-2-min `send-notifications` (CLI + HTTP triggers, system cron
   OR systemd timers in `deploy/`)
9. **Jemaah self-service** `/saya` — public register, booking claim by
   `(bookingNo, phone)` with profile soft-merge, paket browser,
   doc tracking with file upload (`private/docs/<jemaahId>/`)
10. **Notifications** — pluggable channel queue (Fonnte WA + SMTP +
    console default), per-channel + **per-type** opt-out, retry with
    exponential backoff (1m → 5m → 30m → 2h → 12h), admin viewer,
    `/saya/notifications` inbox with unread badge
11. **Payment gateway** — Midtrans Snap (sandbox/prod), `PaymentIntent`
    model + signature-verified webhook + idempotent settlement,
    fake-mode for dev/CI, jemaah-side live polling, admin viewer + stuck-
    intent cancel, auto-expire cron
12. **Crew portal** `/crew` — read-only manifest (money-stripped),
    per-day attendance grid with tuple-guarded mark upsert, CSV export

Built-in **production-readiness**: CSRF protection (double-submit
cookie), CSRF-aware fetch monkey-patch, pluggable rate-limit store
(Redis-ready, fails open), `/api/health` job-freshness check for
external uptime alerting, systemd unit files in `deploy/`.

---

## Repo structure

```
├── prisma/             schema + migrations + seed
├── src/
│   ├── app.js          Express factory (mount order matters)
│   ├── server.js       boot + graceful shutdown
│   ├── env.js          Zod-validated env config
│   ├── lib/            db client, audit, jwt, format, jobRunner,
│   │                   midtrans, docStorage, senders/{fonnte,smtp}
│   ├── middleware/     auth, csrf, error, rateLimit, docUpload
│   ├── services/       business logic (booking, payment, refund,
│   │                   payouts, leads, crew, notifications, …)
│   ├── routes/         HTTP adapters (thin)
│   ├── jobs/           CLI scripts (cron-friendly)
│   └── notifications/  file-based templates
├── views/              EJS templates (server-rendered)
├── shared/             tokens.css (design system) + csrf.js client
├── screens/            static design mockups
├── tests/              node:test files + _helpers.js fixtures
├── scripts/            legacy ad-hoc smoke scripts
├── deploy/             crontab + systemd timers + DEPLOYMENT.md
├── private/            jemaah document uploads (gitignored)
├── CLAUDE.md           full operating manual (architecture, invariants,
│                       conventions — read this before contributing)
└── README.md           you are here
```

---

## Deployment

See [`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md) for a production
runbook covering host prep, env checklist, web vs jobs split, cron
vs systemd timer setup, log rotation, and troubleshooting.

Drop-in artifacts ship in [`deploy/`](deploy/):
- `crontab.example` for `/etc/cron.d/religio-pro`
- `systemd/*.{service,timer}` (3 ops jobs, sandboxed)
- `logrotate.example` for `/etc/logrotate.d/religio-pro`

---

## Contributing

For architecture, invariants, conventions, gotchas, and the
stage-by-stage build history, read [`CLAUDE.md`](CLAUDE.md). It's
the operating manual for any agent (human or AI) that wants to
extend the codebase.

Key rules:
- Append-only audit log; never UPDATE or DELETE `AuditLog` rows
- `recordPayment` is the single source of truth for money math
- Webhook handlers MUST be idempotent (Midtrans retries on non-200)
- `Booking.agentSlugCap` is immutable (historical URL trail)
- Every form POST needs the CSRF hidden input; every fetch-using page
  loads `/shared/csrf.js`

---

## License

Internal — all rights reserved. Not licensed for redistribution.
