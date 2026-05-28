# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A hybrid: a static HTML/CSS design package **+** a Node.js/Express/Prisma/MySQL backend that is being built incrementally on top of those same design files. All copy is Bahasa Indonesia (`lang="id"`). The build-out is staged:

1. ✅ Skeleton (Express + static serving + sensitive-path block)
2. ✅ Prisma schema + MySQL (MariaDB via XAMPP), seed
3. ✅ Auth + RBAC (JWT cookie + bearer, 8 roles, audit, rate-limit)
4. ✅ Public paket landing + booking (`/p/:slug?a=<slug>`) with agent lock-in
5. ✅ Agen portal `/agen` — Leads CRM (Cold/Warm/Hot/Lunas kanban) + Marketing kit + Wallet/komisi + Analytics
6. ✅ Admin/HQ dashboard `/admin` — Overview / Paket / Manifest / Bunking / Finance tabs, plus Users + Jemaah + Audit + Booking-detail pages
7. ✅ Money flow — Payment recording, status transitions, auto-Komisi on LUNAS, cancel + refund (negative-Payment), editable notes
8. ✅ Ops jobs — daily cron to auto-EXPIRE overdue `JemaahDocument` rows (CLI + HTTP trigger)
9. ✅ Jemaah self-service portal `/saya` — public HTML register + booking claim by `(bookingNo, phone)` + read-only booking detail. Claim flow soft-merges anonymous booking-profiles into the user's canonical profile. Logged-in jemaah booking new paket from `/p/:slug` auto-links to their account (no claim needed). Profile + document self-edit at `/saya/profile`, including per-doc file attachment (5mm) stored in private `private/docs/<jemaahId>/`.
10. ✅ Notifications — pluggable channel queue (`Notification` model) with console sender by default. Booking create / payment received / komisi payout auto-enqueue WA + email notifs. Admin viewer at `/admin/notifications`, processed via `npm run job:send-notifications` CLI or HTTP trigger. Jemaah-side inbox at `/saya/notifications` (5ll) scoped via `recipientUserId`; per-channel opt-out (5jj) on `JemaahProfile.notifEmail/notifWa` marks rows `SKIPPED` instead of suppressing them. Retry with exponential backoff (5nn): FAILED rows auto-retry up to 5 attempts (1m/5m/30m/2h/12h) via the same worker before going terminal.
11. ✅ Payment gateway — Midtrans Snap integration (5pp). `PaymentIntent` model decouples gateway state from realized `Payment` rows. Jemaah pays online via `/saya/bookings/:id` "Bayar online" button → Snap hosted checkout → signature-verified webhook materialises a Payment via `recordPayment` (single source of truth for money math + komisi). Fake mode when `MIDTRANS_SERVER_KEY` absent — full intent/webhook loop testable without external creds.
12. ✅ Crew portal `/crew` (5oo) — read-only muthawwif workspace. M2M `PaketCrew` join (admin-managed from paket edit page). Crew see their assigned paket dashboard + a stripped manifest (jemaah identity / phone / emergency contact / passport / room / doc-pills) with NO money fields — separation of duty.

## Running locally

Requires **Node ≥ 20.6.0** — every script uses the built-in `--env-file-if-exists=.env` flag, which is only available from that version.

```bash
npm install
npm run db:migrate          # apply Prisma migrations
npm run db:seed             # seed users + paket + bookings + rooms + leads + payments
npm run dev                 # http://localhost:3001 (3000 collides, see .env)
```

Default port is `3001` (set in `.env`) because something else owns `3000` on this machine. `npm run db:studio` opens Prisma Studio.

`npm run db:reset` runs `prisma migrate reset` — **destructive**: drops the schema, re-runs every migration, and re-seeds. Never invoke without confirming with the user.

Tests run via Node's built-in `node:test` (zero deps, ships with Node ≥ 18). `npm test` runs `tests/*.test.js`; `npm run test:watch` re-runs on file change. New tests go in `tests/` as `<topic>.test.js`. Shared fixtures + cleanup hooks live in `tests/_helpers.js` — use `tempJemaah(t, tag)` / `tempPaket(t, tag, {dayCount})` / `tempBooking({...})`, all registered with `t.after()` so they're scoped per-test. Tests share the dev DB but isolate by unique `makeTag()` prefixes — never assert on global counts (seed rows exist), always filter by tag.

Older `scripts/smoke-*.js` are ad-hoc smoke runners predating `node:test` — they still work standalone (`node scripts/smoke-XX.js`) but new coverage should be written as `tests/*.test.js`. Migrating the legacy smokes is incremental, not a flag-day.

The static design package is still served — visit `/`, `/screens/paket-detail.html`, etc. — but Express now sits in front of it and blocks sensitive files (`.env`, `package.json`, `src/`, `prisma/`, `.claude/`, `memory/`). The `uploads/` directory is intentionally **public** (it's part of the static design package — currently holds `Proposal_Religio_Pro.docx`), so never drop secrets or unredacted user data there.

**Windows file-lock gotcha**: `prisma generate` will fail with `EPERM rename query_engine-windows.dll.node` if the dev server is running (`node --watch` holds the file open). Stop the dev process before running migrate/generate, then restart. Killing one npm/node PID isn't enough — the watch parent spawns a child worker; check `tasklist | grep node` and kill all three (npm wrapper, watcher, child) with `taskkill //F //PID …`.

## Backend architecture

- `src/env.js` — Zod-validated env config. Boot fails fast on bad values.
- `src/app.js` — Express factory. Order: JSON body → cookies → request log (dev) → `blockSensitive` middleware → API routes → static design files → 404 → error handler.
- `src/server.js` — Listens, prints banner, handles SIGINT/SIGTERM + Prisma disconnect.
- `src/lib/db.js` — Prisma client **singleton** (HMR-safe via `globalThis.__prisma`). Use `import { db } from '../lib/db.js'`.
- `src/middleware/error.js` — `HttpError` class + handler. JSON for `/api/*`; HTML 401 → 302 to `/login?next=…`; other HTML errors render `views/error.ejs`.
- `src/lib/format.js` — `res.locals.fmt` exposes `rpShort`, `rpFull`, `date`, `dateShort`, `dateLong` to every EJS template + `toNumber()` helper for Prisma Decimal → number.

### Route mounting order

Mount **nested admin sub-paths BEFORE** the generic `/admin` router, otherwise Express short-circuits on prefix match and the catch-all handler can swallow nested URLs. Same rule for `/api/paket/:slug/{hotels,days,rooms}` mounting before the public `paketJsonRouter`. Current order in `src/app.js`:

```
/api/paket            → paketChildrenRouter (admin JSON CRUD)
/api/paket            → paketJsonRouter (public read)
/admin/paket          → paketAdminRouter
/admin/users          → usersAdminRouter
/admin/jemaah         → jemaahAdminRouter
/admin/bookings       → bookingsAdminRouter
/admin/payouts        → payoutsRouter
/admin/audit          → auditRouter
/admin/notifications  → notificationsRouter
/admin/payment-intents → paymentIntentsRouter   ← 5tt
/admin                → adminRouter (overview/manifest/bunking/finance)
```

### Sensitive-path block

`src/app.js` defines `SENSITIVE_FILES` + `SENSITIVE_PREFIXES`. Any new top-level file or directory containing secrets/code must be added there — `express.static` would otherwise expose it.

## Auth & RBAC

- **Token**: JWT (HS256, issuer `religio-pro`). Read order: `Authorization: Bearer …` → `rp_session` httpOnly cookie. Cookie defaults `sameSite=lax`, `secure` from env.
- **Helpers**: `src/lib/jwt.js`, `src/lib/auth.js`, `src/lib/audit.js` (append-only writer — **never updates or deletes**).
- **Middleware**: `requireAuth`, `requireRole(...roles)`, `optionalAuth` in `src/middleware/auth.js`. Use `requireAuth` *before* `requireRole(...)`.
- **Async routes**: wrap with `asyncHandler(fn)` from `src/lib/asyncHandler.js` (Express 4 doesn't catch rejected promises).
- **Rate limit**: `src/middleware/rateLimit.js` with a pluggable store (`src/lib/rateLimitStore.js`). When `REDIS_URL` env is set → Redis store (atomic `INCR + PEXPIRE` via `MULTI`, multi-instance safe). Unset → in-memory fixed-window bucket (single-instance only). **Fails open on store errors** — a Redis outage logs a warning but allows the request through, so a flaky cache never locks legitimate users out of login. Login: 10/min/IP, register: 5/min/IP. Store kind logged at first use (`[rateLimit] store = Redis ...`). Closed cleanly on SIGINT/SIGTERM via `stopRateLimit()`.
- **JSON API** (`/api/auth/*`): `POST /register` (public, creates JEMAAH only), `POST /login`, `POST /logout`, `GET /me`. Login uses generic "Email atau password salah" regardless of email existence.
- **HTML login** (`src/routes/authWeb.js`): `GET /login`, `POST /login` (form-encoded), `POST /logout`. After login, redirects by role:
  - `AGEN` → `/agen`
  - `JEMAAH` → `/saya`
  - `OWNER` / `SUPERADMIN` / `MANAJER_OPS` / `KASIR` → `/admin`
  - others → `/`
- **HTML register** (`src/routes/jemaahPortal.js`): `GET /register`, `POST /register` (form-encoded, JEMAAH role only, rate-limited 5/min). Creates `User` + linked `JemaahProfile` in one transaction, signs JWT, and redirects to `/saya?welcome=1`. The `/api/auth/register` JSON endpoint still exists alongside.
- **Anti-escalation**: SUPERADMIN cannot create/edit `OWNER` users (`guardEscalation` in `src/services/userAdmin.js`). OWNER role option is disabled in the user form for non-OWNERS.
- **Audit**: every LOGIN attempt (success and failure) and LOGOUT writes an `AuditLog` row with IP, user-agent, and `actorEmail` snapshot so deleted-user history survives.
- **CSRF protection**: `src/middleware/csrf.js` runs after cookie + body parsers, before any route. Double-submit cookie pattern — mints a 32-byte hex token in non-httpOnly cookie `rp_csrf`, requires it back on POST/PUT/PATCH/DELETE via either `X-CSRF-Token` header OR `_csrf` body field. Bypasses GET/HEAD/OPTIONS, the Midtrans webhook (signed by upstream), and `/api/health`. **Every form POST in `views/` MUST include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`** (exposed via `res.locals.csrfToken`). **Every page that uses `fetch()` for state-changing calls MUST load `<script src="/shared/csrf.js"></script>`** before the inline JS — that script monkey-patches `window.fetch` to auto-attach the header from the cookie. Missing either → 403 `CSRF_FAILED` (JSON for `/api/*`, plain text for HTML routes).

## Database

- Prisma 6.x, `mysql` provider (MariaDB-compatible).
- Migrations live in `prisma/migrations/`. Never edit applied migrations — use `prisma migrate dev` to create new ones.
- **AuditLog is append-only** — never write code that updates or deletes rows from it. Same for `Payment` history (refund = new row, not edit).
- Money: `Decimal(15, 2)` for IDR amounts; `Decimal(15, 6)` for exchange rates. Non-IDR amounts also store `amountIdrEq` snapshot.
- Identity: 4 profile tables (`AgentProfile`, `JemaahProfile`, `StaffProfile`, `CrewProfile`) one-to-one with `User`. The 8-role RBAC enum is on `User.role`.
- Agent URL slug: `AgentProfile.slug` (e.g. `ahmad-w`) drives the `?a=` query param on auto-generated paket pages. Booking captures both the FK (`agentId`) **and** a snapshot (`agentSlugCap`) so reattribution audit survives slug renames.
- **Lead model** (`Lead`) is pre-booking only (status `COLD`/`WARM`). When converted, status becomes `CONVERTED` and `convertedBookingId` points at the new booking. `LOST` is terminal.
- **Room model** (`Room`) belongs to a paket; capacity defaults from kelas (QUAD=4, TRIPLE=3, DOUBLE=2, VVIP=1) but is override-able. Composite unique on `(paketId, roomNo)`. `Booking.roomId` is the assignment FK (nullable; cancellation sets it to null automatically).
- **JemaahDocument** — 1-per-type per jemaah (`@@unique([jemaahId, type])`). 8 doc types (PASSPORT/VISA_UMROH/MANASIK_CERT/HEALTH_CERT/VACCINE_MENINGITIS/MARRIAGE_CERT/FAMILY_CARD/OTHER), 5 statuses (PENDING/SUBMITTED/VERIFIED/REJECTED/EXPIRED). `upsertDoc` auto-stamps `submittedAt`/`verifiedAt` on status transitions (only on transitions — re-saving the same status does NOT re-stamp). Optional file attachment (5mm): `filePath`/`fileName`/`fileSize`/`mimeType`/`fileUploadedAt`; file lives at `private/docs/<jemaahId>/<docId>__<sanitised-basename>.<ext>`. One file per doc — re-upload replaces the prior file on disk.
- **PaymentIntent** (5pp) — gateway-side state, separate from `Payment` so an intent can fail (EXPIRED/CANCELLED/FAILED) without ever producing a money movement. Lifecycle: `CREATED → PENDING → SETTLED` (happy path) or terminal failure. `paymentId` 1:1 FK fills in only on first SETTLED transition — the guard against double-credit (Midtrans retries webhooks on failure). `orderId` format `PI-<intentId>` is the join key with Midtrans.
- **PaketCrew** (5oo) — M2M between `Paket` and MUTHAWWIF users. Composite PK `(paketId, userId)` makes assign-twice naturally idempotent (upsert). Assignment to ARCHIVED / soft-deleted paket is permitted (admin may want to keep historical record) but `listAssignedPaket` filters them out of the crew dashboard.
- **AttendanceMark** (5ww) — one per `(bookingId, paketDayId)` (`@@unique`), recording who showed up to each itinerary day. `present` Boolean + optional `notes`; `markedByUserId/At` stamps which crew last touched it. Re-marking is upsert — DB rows never duplicate. **No audit log** for these — high-volume per-trip operation; the row itself is the trail. Cascade delete on Booking + PaketDay for cleanup safety.

### Seed credentials & demo data

`prisma/seed.js` is idempotent. Seeded users:
- `owner@religio.pro` / `owner12345` — OWNER
- `kasir@religio.pro` / `kasir12345` — KASIR
- `ahmad@religio.pro` / `ahmad12345` — AGEN, slug `ahmad-w`

Seeded content (all belonging to one paket, `ramadhan-aqsa-2026`):
- 4 hotels (Madinah/Mekkah/Aqsa/Petra), 4 prices (Quad→VVIP, Double featured), 7 itinerary days
- 12 rooms (M-401..408 on lt 4 wing Selatan/Utara; M-501..504 on lt 5 wing Selatan/Eksekutif)
- 5 demo bookings `RP-DEMO-0000{1..5}` for `ahmad-w` (mixed statuses including 2 LUNAS) with Payment rows synced to paidAmount via `gatewayRef=DEMO-PAY-…`
- 6 demo leads (3 COLD + 3 WARM, mixed sources, with `phone` prefix `0888-DEMO-…` for idempotency)

## Public paket landing + booking (step 4)

- `GET /p/:slug` renders `views/paket.ejs` from DB. `?a=<agentSlug>` resolves to an `AgentProfile`; unknown slugs render the page in "no-agent / Kantor Pusat" mode.
- `GET /api/paket/:slug` returns the same data as JSON.
- `POST /api/booking` — public, anonymous, 8/min/IP rate limit.
- **Agent lock-in invariant**: `Booking.agentId` is set only when the slug resolves; `Booking.agentSlugCap` *always* snapshots the slug from the URL — even if invalid. A future audit can prove which URL the visitor came from, even if the slug is later deleted or reassigned.
- **Booking number scheme**: `RP-YYYY-NNNNN`. Generated by counting existing prefix-matched rows; collisions retry up to 5 times (uniqueness enforced by `bookingNo @unique`).
- **`paket.ejs` hotel render quirk**: the landing template explicitly renders only Madinah + Mekkah hotels in the "hotels" section. Hotels in other cities (AQSA, PETRA, ISTANBUL, JAKARTA, etc.) are stored fine but won't appear on the public landing page without a template change.
- **Authenticated self-booking (5t)**: both `GET /p/:slug` and `POST /api/booking` use `optionalAuth`. When the visitor is a logged-in JEMAAH, the form pre-fills name+phone from their `JemaahProfile`, and `createBooking` reuses that profile (no new row spawned) + sets `Booking.jemaahUserId` directly. A "Booking untuk orang lain?" link sends `forceAnonymous=1` in the form body to opt out of the link and spawn a fresh profile for the third-party jemaah.
- **Admin walk-in booking (5w)**: `GET /admin/bookings/new` + `POST /admin/bookings` (4 admin roles incl. KASIR) wraps the same `createBooking` service with an `adminCreator = {id,email,role}` param. When set, the function **forces `loggedInUser = null`** (the admin session is the actor, not the jemaah) — `selfBooked` stays false and `jemaahUserId` stays null so the jemaah can still later register + claim the booking themselves via `/saya`. Audit row marks `after.adminCreated = true` with the admin's actor email/role.
- **Separation of duties for money flow**: roles are split deliberately. `KASIR` records incoming payments + creates walk-in bookings, but **cannot** issue refunds (5m) or disburse komisi payouts (5x) — those need OWNER/SUPERADMIN/MANAJER_OPS. Don't extend the KASIR role to outbound money without a deliberate decision; the current split mirrors how cash-handling controls work in physical offices.
- **Notification enqueues are fire-and-forget**: every `enqueueNotification` and event-helper call inside `booking.js` / `payment.js` / `payouts.js` is wrapped in try/catch. A failure to insert the notif row (DB hiccup, bad payload, missing template) logs to console but never aborts the transaction that triggered it. The notif row becomes the audit trail of "we tried to tell the jemaah" — even when the actual send fails, the queue + admin viewer surface the gap. **Do not** add notif writes inside the same `$transaction` as money-state writes — the right priority order is "save money state first, attempt notify second".
- **Komisi rate immutability (5u/5v)**: when `Paket.komisiRate` or `AgentProfile.komisiRateOverride` changes, **existing `Komisi` rows are NOT recomputed**. The rate at the moment of the LUNAS transition is locked in via the `Komisi.amount` snapshot. This is the right behaviour — historical earnings reflect the contract that was in force when the agent earned them — but means a "global rate change" admin should bump expectations, not historical numbers. Form helper text spells this out.
- **3-state Zod schema for nullable form fields** — when a form field needs to support "explicit clear" (empty input → `NULL` in DB) vs "leave unchanged" (field not in body), the preprocessor must distinguish three input states: `undefined` (key absent → no DB write), `null` (key present, value empty → clear to NULL), and a real value. Naive `(v) => v === '' ? undefined : Number(v)` collapses the first two, so empty input fails to clear. See `komisiOverridePct` in `src/services/userAdmin.js` for the pattern: `z.union([z.number()…, z.null()]).optional()` paired with a preprocessor that maps the three cases distinctly.

## Agen Portal (`/agen`)

`requireAuth + requireRole('AGEN')`. Single-page with 4 client-switched tabs (state preserved in `?tab=` query param):

- **Leads Pipeline** — 4-column kanban. `Cold` + `Warm` from `Lead` rows (`status IN ('COLD','WARM')`). `Hot/DP` from `Booking` rows (`status IN ('PENDING','BOOKED','DP_PAID','PARTIAL')`). `Lunas` from `Booking` rows with `status=LUNAS`. KPI strip on top. Inline lead create/edit/delete via fetch; **Promote to Booking** modal on WARM cards calls `POST /api/leads/:id/convert` which reuses the public `createBooking()` and sets `Lead.status=CONVERTED + convertedBookingId`.
- **Marketing kit** — list of ACTIVE paket; each card shows the auto-generated link `/p/<slug>?a=<agent.slug>` with copy-to-clipboard button.
- **Wallet & Komisi** — totals + transaction list (komisi grouped by status PENDING/EARNED/PAID/CANCELLED) + read-only payout history table (last 20 `KomisiPayout` rows for this agent, with payoutNo + method + reference for bank-statement cross-check).
- **Analitik** — funnel (5 stages from Cold to LUNAS) + lead source breakdown + 30-day sparkline. Date range filter (`from`/`to` query params, defaults to 30-day window).

All `/api/leads/*` endpoints are scoped to the logged-in agent's profile via `resolveAgent` middleware in `src/routes/leads.js` (ownership enforced by `loadOwnedLead`). Cross-agent access returns 403.

## Jemaah Portal (`/saya`)

`requireAuth + requireRole('JEMAAH')`. Anonymous public bookings each create a fresh `JemaahProfile`, so a returning jemaah usually has multiple profile records floating around. The portal stitches them back together via a **claim** flow.

- **`GET /register`** — public HTML form. Creates JEMAAH user + linked profile; auto-logs-in.
- **`GET /saya`** — dashboard. Shows claim form + list of bookings where `Booking.jemaahUserId = req.user.id`.
- **`POST /api/saya/claim`** — body `{bookingNo, phone}`. Matches `bookingNo` exact + `phone` after stripping spaces/dashes/parens. Generic 404 on any mismatch (deliberate — guards against bookingNo enumeration). 409 if already claimed by a different user. Idempotent if same user.
- **`GET /saya/bookings/:id`** — read-only booking detail (no admin tools). Ownership via `jemaahUserId` filter.
- **`GET /saya/profile`** — form for editing the jemaah's own canonical profile (the one linked via `JemaahProfile.userId`). Fields are the same set admin can edit on `/admin/jemaah/:id/edit`; validation reuses `JemaahSchema` from `src/services/jemaahAdmin.js`.
- **`POST /api/saya/profile`** — JSON update for the form above. Audit row uses `actor.role=JEMAAH` as the self-edit signal (no explicit `via` flag needed). Form includes a "Preferensi notifikasi" panel (5jj) with two channel toggles (`notifWa`, `notifEmail`); the route normalises unchecked HTML checkboxes to explicit `false` before calling `updateMyProfile` so opting out actually persists (an unchecked checkbox is absent from `req.body` — without the normaliser the `notifPref` preprocessor reads it as "no change").
- **`POST /api/saya/documents`** + **`DELETE /api/saya/documents/:id`** — jemaah self-submits or removes their own document tracking. Restrictions in the next section.
- **`GET /saya/paket`** (5dd) — browser for ACTIVE paket with a per-card `alreadyBooked` badge based on the jemaah's existing non-cancelled bookings. "BOOK SEKARANG" links to `/p/:slug` where 5t's pre-fill kicks in; the CTA label flips to "BOOK LAGI" when a prior booking exists. Single batched query for the user's bookings (no N+1).
- **`POST /api/saya/bookings/:id/request-cancel`** (5ff) — jemaah submits a cancellation request with a reason. Sets `Booking.cancelRequested = true` + `cancelRequestedAt` + `cancelRequestReason`, but **does NOT change `status`** — admin must still approve via `cancelBooking`. Refuses if booking is CANCELLED/REFUNDED or a prior request is already pending (409 `ALREADY_REQUESTED`). When admin runs `cancelBooking`, the three request fields are cleared in the same transaction (implicit approval — no separate "approve request" endpoint). Admin surfaces: amber banner at the top of `/admin/bookings/:id` info panel, plus a "REQ CANCEL" badge under the status pill in the manifest table.
- **`GET /saya/notifications`** (5ll) — read-only inbox of the jemaah's own notifications. Filtered strictly by `Notification.recipientUserId = req.user.id` (capped at 50, newest first). Channel badge + status pill (PENDING/SENT/FAILED/SKIPPED) + body preview + error message when not SENT. The page links back to `/saya/profile` so an opted-out jemaah seeing rows with `status=SKIPPED, error="recipient opted out of WA notifications"` has a clear path to flip the toggle. Admin/system notifs (e.g. `CANCEL_REQUESTED` fan-out to admin emails) deliberately enqueue **without** `recipientUserId`, so they never leak into any jemaah inbox. **Unread badge (5rr)**: dashboard topbar shows a gold count pill next to the "Notifikasi" link via `countUnreadForUser`. Opening the inbox calls `markAllReadForUser` *after* fetching the rows, so rendered unread rows get a gold left-border + dot affordance on first visit, then the badge clears for next render. `Notification.readAt` is null until first view; admin/system rows (no `recipientUserId`) are never counted.

### Self-submit document rules (5s)

The jemaah-side `submitMyDoc` in `src/services/jemaahPortal.js` enforces tighter rules than the admin's `upsertDoc`:

- **Status is inferred from input, never set directly.** `refNumber` filled → `SUBMITTED`; empty → `PENDING`. Jemaah can never set `VERIFIED` or `REJECTED` — those are staff verdicts.
- **Re-submitting a `VERIFIED` doc resets the verdict**: status drops to `SUBMITTED`, `verifiedAt`/`verifiedById` are cleared. This handles the re-review workflow (e.g. paspor renewed, new ref number).
- **`deleteMyDoc` refuses to delete `VERIFIED` docs** (409 `DOC_LOCKED`) — staff sign-off is a soft lock; only admin can remove a verified record.
- Auth signal in audit: `actorRole=JEMAAH` is sufficient — no `selfSubmit: true` flag needed (though the implementation does add it to `after` for explicit grep).

### Document file uploads (5mm)

Files attach to an existing `JemaahDocument` row (1 file per doc, re-upload replaces). Flow:

- **Storage**: `private/docs/<jemaahId>/<docId>__<sanitised-basename>.<ext>`. The `private/` dir is in `SENSITIVE_PREFIXES` (`src/app.js`) — `express.static` returns 404 for any direct request, files are only reachable via authenticated download routes. **Any new private dir must be added to that prefix list** before being used for uploads, otherwise it leaks.
- **Multer two-step**: `src/middleware/docUpload.js` writes incoming files to OS temp via multer disk storage; the route handler then calls `moveUploadedFile()` in `src/lib/docStorage.js` to relocate them into the per-jemaah dir. This split keeps multer agnostic of `jemaahId/docId` (only known after auth + param resolution).
- **Limits**: 8 MB cap (`MAX_DOC_BYTES`), mime allowlist `PDF / JPG / PNG / WEBP / HEIC` (`ALLOWED_MIME`). Both are enforced in multer's `fileFilter`/`limits` AND re-checked in the service before move — defence in depth.
- **Filename rule**: `sanitiseBasename()` strips path separators, diacritics, and non-portable chars; caps to 100 chars; falls back to `"file"` on empty. Applied to both the on-disk filename AND the `fileName` column used in `Content-Disposition`. **Never trust the user's raw filename for either path or download header.**
- **Status side-effects on upload**: PENDING → SUBMITTED (file presence = "I've submitted it"); VERIFIED → SUBMITTED + `verifiedAt`/`verifiedById` cleared (mirrors `submitMyDoc` re-review behaviour). Other statuses pass through unchanged.
- **Delete coverage**: `deleteMyDocFile` removes the file but keeps the row; `deleteMyDoc` (jemaah) + admin `deleteDoc` both delete the file on disk too (best-effort) so deleting a doc row never leaves an orphan blob. VERIFIED docs refuse both kinds of delete from the jemaah side (`DOC_LOCKED` 409) — only admin can remove.
- **Download routes** (auth + ownership enforced per-request, NOT via static):
  - `GET /saya/documents/:docId/file` — jemaah; ownership = `doc.jemaah.userId === req.user.id`
  - `GET /admin/jemaah/:jemaahId/documents/:docId/file` — admin RBAC + **tuple guard**: rejects with 404 unless `doc.jemaahId === :jemaahId`. The tuple guard prevents enumerating files across jemaah by guessing docIds on a fixed jemaah URL.
- Both responses are `Content-Disposition: inline` with the stored `fileName` — browsers preview PDFs/images directly; users get a sensible "Save as" name.
- **Inline thumbnails (5vv)** — the doc panels (`/saya/profile` + `/admin/jemaah/:id/edit`) render a 56-64px `<img>` thumbnail when `mimeType ∈ {image/jpeg, image/png, image/webp}` (via `isInlineImageMime()` in `src/lib/docStorage.js`); PDF gets `📄`, anything else (HEIC/HEIF) gets `🖼️`. HEIC is deliberately fallback even though it's in the upload allowlist — Chrome/Firefox don't ship HEIC decoders, so an `<img>` tag would render a broken-image square. The thumbnail `src` is the same auth-gated download URL — browser cookies handle the auth + ownership check, no separate thumbnail endpoint. **No server-side resize**: thumbnails are the full image scaled by CSS. Fine at 8 MB max + typical 8 docs/jemaah; if it ever becomes a bottleneck, add `sharp`/`jimp` cached thumbs at `private/docs/<jemaahId>/thumbs/`.

### Profile soft-merge on claim (5p.2)

On every successful claim, `claimBooking` runs a soft-merge inside one transaction when the user has their own profile AND the booking points elsewhere. **Order is load-bearing** — re-point booking FIRST so the source's remaining-bookings count is accurate, then merge with knowledge of whether source will be deleted:

1. Re-point `Booking.jemaahId` from the anonymous booking-profile → the user's canonical profile.
2. Count source's remaining bookings (zero ⇒ source becomes an orphan and will be deleted).
3. Run `mergeProfileInto(target, source, { sourceWillBeDeleted })`:
   - **User profile wins** on conflict: copy `nik / passportNo / passportExpiry / birthDate / gender / address / emergencyContact / notes` from source only when the user's field is null/empty.
   - **Defensive @unique check** for `nik` and `passportNo` — excludes both target AND source from the clash query; only a *third* profile counts as a real conflict.
   - **@unique transfer requires source orphan**: when source still has other bookings, we can't take its NIK/passport away (those other booking-profiles would lose the data) — skip the copy, source keeps the value. When source is about to be deleted, NULL its @unique field first (frees the DB constraint), then patch the value onto target.
4. Transfer `JemaahDocument` rows from source → user. **User wins** on `(jemaahId, type)` collision (source duplicate deleted; source unique re-pointed).
5. Delete the source profile if it has zero remaining bookings.
6. Audit `Booking UPDATE` includes `{merged, targetJemaahId, fieldsCopied, docsTransferred, oldProfileDeleted}` summary.

This means a jemaah who has booked 3 paket anonymously, then registers and claims all 3, ends up with a single canonical profile + their docs consolidated — even though the public booking flow keeps creating new profile rows.

After 5t, the merge path mostly handles **legacy** anonymous bookings made before the user registered. New bookings made while logged in already point at the canonical profile (and have `jemaahUserId` set), so the merge becomes a no-op for them.

## Crew Portal (`/crew`)

`requireAuth + requireRole('MUTHAWWIF')`. Read-only workspace for guides/leaders travelling with the jemaah. Login redirect: MUTHAWWIF → `/crew` (added to `redirectForRole` in `src/routes/authWeb.js` alongside AGEN/JEMAAH).

- **`GET /crew`** — dashboard. Lists paket where this user has a `PaketCrew` row, scoped to non-ARCHIVED + non-soft-deleted, sorted by `departureDate` ascending (next trip on top). Each card: title, slug, departureDate, durationDays, booking count, kursi terisi vs kursi total, status badge.
- **`GET /crew/paket/:slug`** — manifest. Returns 404 (generic `NOT_ASSIGNED`) when the crew isn't assigned — anti-enumeration. Includes per-jemaah: `bookingNo`, `kelas`, `paxCount`, `status`, room assignment, jemaah `fullName`/`phone`/`emergencyContact`/`passportNo`/`passportExpiry`, plus `docPills` (5-type curated strip via `pillsForJemaah`). Filters out CANCELLED/REFUNDED bookings — manifest is "who's actually going on this trip".
- **`GET /crew/paket/:slug/export.csv`** (5ss) — offline-friendly CSV snapshot of the same manifest. Built for crew on the road with weak/no signal — open in any spreadsheet app on a phone or laptop. UTF-8 BOM + RFC 4180 quoting (same convention as the admin 5gg export). Filename `crew_manifest_<slug>_<YYYY-MM-DD>.csv`. Same money-stripped column set as the HTML manifest — booking identity, room, and per-curated-doc-type state, **no totalAmount/paidAmount**. Refuses (404 `NOT_ASSIGNED`) when the requesting crew isn't on the paket — the assignment guard is the same as the HTML view.
- **`GET /crew/paket/:slug/attendance`** (5ww) — per-day attendance overview. Lists every `PaketDay` (in itinerary order) with `presentCount` / `markedCount` / `totalActive` so crew sees at a glance which days are unmarked. Active bookings only (CANCELLED/REFUNDED excluded) — matches the manifest definition of "who's actually going".
- **`GET /crew/paket/:slug/attendance/:dayId`** (5ww) — per-day grid: jemaah list + a custom checkbox toggle + free-text notes input per row, POST to `/crew/paket/:slug/attendance/:dayId/:bookingId`. The service `setAttendanceMark` enforces a **tuple guard**: `(dayId, bookingId)` MUST both belong to the assigned paket — cross-paket combinations return 404 (anti-enumeration; same generic 404 as the unassigned case). Each save shows a green confirmation banner, then strips `?ok=saved` from the URL so reloads don't keep flashing it. Admins can audit the resulting marks at `/admin/paket/:slug/attendance` (5zz — see Admin Dashboard sub-pages).
- **No write surface beyond attendance** — crew cannot edit jemaah / payments / room assignment from the portal. SOS / chat from the static `screens/crew-app.html` mockup are deliberate follow-ups, not part of 5oo/5ww.
- **Money-stripped on purpose**: `getAssignedManifest` does NOT select `totalAmount` / `paidAmount` / `payments`. Crew often help with logistics but cash collection is a separate role (KASIR) — keeping balances out of the crew UI mirrors the existing separation of duties around outbound money (5x: KASIR can't disburse payouts).

Admin manages assignment from `/admin/paket/:slug/edit`: a "Crew (muthawwif)" panel lists currently-assigned users + a dropdown of every ACTIVE MUTHAWWIF for one-click assign. Wire-up via JSON: `POST /api/paket/:slug/crew` (`{ userId }`) and `DELETE /api/paket/:slug/crew/:userId` — both in `src/routes/paketChildren.js` so they pick up the existing OWNER/SUPERADMIN/MANAJER_OPS gate.

## Admin Dashboard (`/admin`)

`requireAuth + requireRole('OWNER','SUPERADMIN','MANAJER_OPS')` (KASIR can view some pages, see per-route guards). Tabbed single page (`?tab=`):

- **Overview** — KPIs (revenue LUNAS, potensi Hot, jemaah, komisi earned), status breakdown, top paket, performa agen (with lead conversion %), lead source effectiveness, global funnel, per-paket revenue trend with inline SVG sparklines (5ee — single-query group-by-day, missing days zero-filled so X-axis stays consistent). Funnel, source breakdown, and revenue trend honor the date range filter (`from`/`to`); KPI strip and top-paket panel are always all-time.
- **Paket** — grid of paket cards (`status≠ARCHIVED`) with badges (ACTIVE emerald / DRAFT amber / CLOSED ruby). Links to landing + manifest + edit.
- **Manifest** — per-paket booking table with doc-completion pills (`docPills` computed via `pillsForJemaah(documents)`). Pay button per row opens modal → `POST /api/payments`. Booking number links to detail page. **CSV export** button (5gg) downloads `manifest_<slug>_<YYYY-MM-DD>.csv` via `GET /admin/manifest/:slug/export.csv` — 20 cols (bookingNo, status, kelas/pax, jemaah identity, money, agen, timestamps, doc counts), UTF-8 with BOM so Excel detects encoding correctly, fields wrapped/escaped per RFC 4180.
- **Bunking** — per-paket room grid grouped by floor+wing + sidebar of UNASSIGNED bookings. Assign modal filters rooms to matching kelas + slots-left. Capacity check enforced server-side (`assignBookingToRoom` in `src/services/bunking.js`).
- **Finance** — cash by currency (IDR/USD/SAR), receivables, payment ledger 20-row.

### Admin sub-pages (separate URLs, share sidebar via duplicated layout)

- `/admin/paket/{new,:slug/edit}` — full CRUD form. Hotels + Days + Rooms managed as interactive panels via JSON endpoints `/api/paket/:slug/{hotels,days,rooms}` (POST/PATCH/DELETE).
- `/admin/paket/:slug/attendance` (5zz) — read-only attendance audit for crew's 5ww marks. Two tables: per-day (marked/present/rate) and per-jemaah (daysPresent/daysMarked/rate). **Rate formula deliberately divides by `totalDays`, not `daysMarked`** — unmarked days count as not-present, so crew can't boost rate by skipping the form. Cross-linked from the paket-form crumb. OWNER/SUPERADMIN/MANAJER_OPS (mounted under `paketAdminRouter`, so it inherits that gate).
- `/admin/users` + `/:id/edit` — list with filter (search/role/status), create+edit form with role-conditional profile section (Agent/Staff/Crew/Jemaah), reset-password panel, suspend/reactivate buttons. OWNER+SUPERADMIN only.
- `/admin/jemaah` + `/:id/edit` — list with passport-expiry badges (ok/warning <180d/urgent <90d/expired), search + `?expiringSoon=1` filter. Edit form: identity + passport + address + 8-row document tracking panel (inline fetch save/delete). Each doc with a `filePath` shows a "Lihat" download link to `GET /admin/jemaah/:id/documents/:docId/file` (5mm). OWNER+SUPERADMIN+MANAJER_OPS.
- `/admin/audit` + `/:id` — paginated 50/page list with entity/action/actorEmail/date-range filters. Detail shows before/after JSON side-by-side. OWNER+SUPERADMIN only. **Read-only — never expose writes here.**
- `/admin/notifications` — queue viewer with filter (status/channel/type). Per-row "SEND NOW" button for one-off dispatch + a "Proses Queue Sekarang" header button that POSTs to the HTTP trigger. OWNER/SUPERADMIN/MANAJER_OPS.
- `/admin/payment-intents` (5tt) — global cross-booking PaymentIntent list, paginated 50/page. KPI strip + filters (status/search/date range). Search matches order ID OR booking number (cross-table OR). Read-only — per-intent cancel still lives on the booking detail page (5qq) for context. OWNER/SUPERADMIN/MANAJER_OPS.
- `/admin/bookings/:id` — detail page (view: 4 roles, cancel/refund/notes-edit/agent-transfer/intent-cancel: 3 roles, KASIR view-only). Header status badge, info grid (with inline-editable notes textarea), money row with progress bar, payment table (negative refund rows in ruby with `−` prefix), payment-intent panel (5qq — online gateway attempts + per-row stuck-intent cancel for CREATED/PENDING), komisi table, audit timeline (filtered to this booking), cancel + refund + transfer-agen modals.
- `/admin/bookings/new` — walk-in booking creation form (4 admin roles incl. KASIR). Paket + optional agent dropdowns, jemaah name/phone, kelas/pax/notes. Reuses the public `createBooking` service via `adminCreator` param (see "Admin walk-in booking" invariant below). Linked from the sidebar "Operasional → + Booking baru".
- `/admin/payouts` + `/new` + `/:id` — komisi disbursement workspace (OWNER/SUPERADMIN/MANAJER_OPS — **KASIR explicitly excluded** because the kasir who records inbound payments shouldn't also approve outbound payouts; classic separation of duties). List shows outstanding `EARNED` per agent + history of past payouts. Detail page shows the bundled komisi rows with links back to each booking.

### Payment + status machine

`src/services/payment.js` exports `recordPayment()` (transactional) and `transitionStatus()` (forward-only state machine):

- `paid <= 0` → keep status
- `paid >= total` → `LUNAS`
- PENDING/BOOKED + partial → `DP_PAID`
- DP_PAID + partial → `PARTIAL`
- Already PARTIAL/LUNAS/CANCELLED → unchanged

On LUNAS transition, if `booking.agentId` is set, idempotently creates a `Komisi` row (`amount=rate × total`, `status=EARNED`, `earnedAt=now`). The rate is resolved by an **explicit precedence chain** in `payment.js`:

1. `AgentProfile.komisiRateOverride` (Decimal(5,4)?) — set per-agent via admin user form's "Override komisi (%)"
2. `Paket.komisiRate` (Decimal(5,4), default `0.06`) — set per-paket via paket edit form's "Komisi agen (%)"
3. `DEFAULT_KOMISI_RATE = 0.06` in `payment.js` — defensive fallback only; schema defaults keep real rows populated.

For a per-paket × per-agent matrix (e.g. "ahmad-w gets 15% on VVIP only"), add a join table `AgentPaketKomisi(agentId, paketId, rate)` and prepend it to the chain.

### Cancel booking

`src/services/bookingAdmin.js → cancelBooking()` is transactional:
- `status=CANCELLED`, `cancelledAt`, `cancelReason` set
- `Paket.kursiTerisi.decrement(paxCount)` — seats released back to quota
- `Booking.roomId = null` — auto-unassign from room
- `Komisi.updateMany({EARNED → CANCELLED})` — PAID komisi stays (already disbursed)
- Payment rows **NOT touched** — refund is a separate flow (see below)

### Refund (`src/services/refund.js`)

Workflow is strict: **cancel first, refund after**. `issueRefund()` only runs on `status=CANCELLED` bookings (returns 409 otherwise). Behaviour:
- Creates a **new** Payment row with negative amount and `status=REFUNDED` (Payment is append-only — never mutates the original PAID rows).
- Decrements `Booking.paidAmount`. When it reaches 0, transitions `Booking.status` to `REFUNDED` (terminal — no further refunds possible).
- Partial refunds are repeatable: call multiple times until `paidAmount = 0`.
- Refund amount cannot exceed current `paidAmount` (409 with formatted message).
- Komisi is NOT re-touched here (cancel already handled `EARNED → CANCELLED`; `PAID` stays as-is).
- `KASIR` cannot issue refunds (`OWNER/SUPERADMIN/MANAJER_OPS` only) — more restrictive than payment recording.
- `getFinanceSummary` sums `PAID + REFUNDED` together so cash-by-currency reflects net position (refunds reduce the bucket).

### Payment gateway — Midtrans Snap (5pp)

Online payment via Midtrans Snap (hosted checkout). `src/lib/midtrans.js` is the HTTP client + signature verifier; `src/services/paymentGateway.js` is the lifecycle (createPaymentIntent → handleMidtransNotification); `src/routes/paymentGateway.js` exposes the public surface.

- **Flow**: jemaah clicks "Bayar online" on `/saya/bookings/:id` → `POST /api/payments/intent` creates a `PaymentIntent` + asks Midtrans for a Snap token → jemaah redirected to Snap hosted page → on completion, Midtrans calls `POST /api/payments/midtrans/webhook` → handler verifies signature → on `settlement`, materialises a Payment row via `recordPayment`.
- **Webhook delegates to `recordPayment`** — the gateway handler NEVER touches `Booking.paidAmount`/`status` or `Komisi` directly. It builds the right args and defers to `recordPayment` (in `src/services/payment.js`), which is the single source of truth for money math + status transitions + komisi creation. This keeps gateway-paid and admin-recorded payments converging on identical post-state. After `recordPayment` succeeds, the handler also fans out an admin email via `notifyPaymentSettledAdmin` (5yy) — non-blocking, never aborts the webhook ack to Midtrans.
- **Idempotency**: Midtrans retries webhooks on non-200. The handler guards on `intent.paymentId != null` before calling `recordPayment` — duplicate `settlement` payloads return `NOOP` without double-crediting. Composite invariant: `(intent.status === 'SETTLED' && intent.paymentId != null) ⇒ Payment already exists`.
- **Signature verification** (`verifyMidtransSignature`): `SHA512(order_id + status_code + gross_amount + server_key)`, compared with `crypto.timingSafeEqual`. Rejects malformed payloads early. Route returns 401 `BAD_SIGNATURE` without revealing whether the intent exists.
- **Status frozen at terminal**: once `intent.status ∈ {SETTLED, EXPIRED, CANCELLED, FAILED}`, later webhooks only snapshot `gatewayPayload`/`gatewayStatus` for audit — they don't re-transition status. Prevents a stale `cancel` event from reverting a successful settlement.
- **Active-intent guard**: `createPaymentIntent` refuses if there's already a `CREATED`/`PENDING` intent for the booking, unless caller passes `replaceActive=true` (which marks the old one CANCELLED first). The UI button passes `replaceActive=true` so re-clicking "Bayar online" doesn't pile up dangling intents. The 5uu sweep job auto-EXPIRES intents whose `expiresAt` has passed without admin intervention, so abandoned Snap sessions naturally self-clear without needing manual cancel (5qq) for every dead session.
- **Status → enum map** (`mapMidtransStatus`): `settlement` / `capture+accept` → SETTLED; `pending` → PENDING; `deny`/`failure` → FAILED; `cancel` → CANCELLED; `expire` → EXPIRED. `payment_type → PaymentMethod` map (`mapMidtransMethod`): `credit_card → CARD`, `bank_transfer/echannel → VA`, `qris → QRIS`, `gopay/shopeepay/dana/linkaja → EWALLET`, anything unrecognised → TRANSFER (with raw type captured in `Payment.notes`).
- **Fake mode** (default when `MIDTRANS_SERVER_KEY` is absent — i.e. local dev): `createSnapTransaction` returns `{ token: "fake-snap-<orderId>", redirect_url: "/payments/midtrans/fake?order_id=..." }`. The local route `GET /payments/midtrans/fake` builds a valid (signature-correct) webhook payload and invokes the handler in-process, then redirects back to `/saya/bookings/:id?paid=ok`. Lets the full intent → webhook → Payment loop run in smoke without external creds. Refuses to operate in real mode (returns 403 `NOT_FAKE_MODE`) so the local handler can't be exploited in production.
- **Production wiring**: set `MIDTRANS_SERVER_KEY` + `MIDTRANS_CLIENT_KEY` + `MIDTRANS_PRODUCTION=true` in `.env`, register `https://<your-domain>/api/payments/midtrans/webhook` in Midtrans dashboard. The Snap client switches between `app.sandbox.midtrans.com` (default) and `app.midtrans.com` (production) based on `MIDTRANS_PRODUCTION`.
- **Admin viewer + stuck-intent cancel (5qq)** — `/admin/bookings/:id` shows a "Payment Intents" panel listing every intent ever created for the booking (newest first), with order ID, status pill, gateway raw status, amount, and a cross-reference to the resulting Payment when SETTLED. CREATED/PENDING rows render a "CANCEL" button → `POST /admin/bookings/:id/intents/:intentId/cancel` → `cancelStuckIntent` flips status to CANCELLED. Use when a Snap session is dead but Midtrans never sent a webhook (e.g. jemaah closed the tab) — without this the active-intent guard would block them from starting fresh. **Refuses on terminal status** (`SETTLED/EXPIRED/CANCELLED/FAILED` → 409 `INTENT_NOT_CANCELLABLE`); to reverse a settled payment, use the refund flow instead. Same RBAC as cancel/refund (OWNER/SUPERADMIN/MANAJER_OPS — KASIR view-only).
- **Global viewer (5tt)** — `/admin/payment-intents` is a paginated cross-booking list (50/page) for ops investigation ("why didn't this user's payment go through?"). KPI strip on top shows counts per status; filters: status, text search (matches orderId OR bookingNo substring via Prisma relation OR), date range on `createdAt`. **`countsByStatus` is computed WITHOUT the status filter** — KPIs always reflect the full distribution within the current search+date scope, so flipping the status dropdown doesn't make the KPI numbers misleading. Sidebar link in the admin dashboard rail. Same 3-role gate.
- **Jemaah-side live polling (5xx)** — `/saya/bookings/:id` injects the latest non-terminal intent via `getActiveIntentForJemaahBooking` (scoped to `booking.jemaahUserId`). When present, the view renders a gold-bordered status card above the "Bayar online" panel — order ID, amount, status, gateway raw status, "Lanjut bayar" link to `snapRedirectUrl`. Client-side JS polls `GET /api/payments/intent/:id` every 15 s (max 20 ticks ≈ 5 min) via `setTimeout` chain (not `setInterval`, so slow responses can't overlap). On `SETTLED` the card turns green + auto-reloads the page so the Payment table picks up the new row. Terminal `EXPIRED/CANCELLED/FAILED` flips card red and stops polling. Network blips silently retry on the next tick. Polling NEVER returns a terminal intent — `getActiveIntentForJemaahBooking` filters them out, so the card naturally disappears on reload after settlement.

### Komisi disbursement (5x)

`src/services/payouts.js → createPayout({agentId, method, reference, notes})` bundles all of one agent's `EARNED` komisi into a single `KomisiPayout` row and flips them to `PAID` atomically:

- **Payout number scheme**: `PO-YYYY-NNNNN` — mirrors `bookingNo` (`RP-…`) generation: count prefix-matched rows, retry on `@unique` collision.
- **Snapshot at creation**: `KomisiPayout.amount = sum of EARNED komisi at the moment of write`. Never recomputed even if child rows are later edited.
- **Idempotency guard**: refuses with 409 `NO_EARNED_KOMISI` if the agent has zero EARNED komisi (prevents empty payouts).
- **`Komisi.payoutId` is `onDelete: SetNull`** — if a payout row is later deleted, the komisi rows stay PAID but become "unbundled" (no payout reference). This is graceful degradation, not data loss.
- Audit `KomisiPayout UPDATE` row includes `{payoutNo, agentSlug, amount, method, komisiCount, komisiIds[]}`.

### Booking notes

`updateBookingNotes()` is no-op if the value didn't actually change — avoids polluting `AuditLog` with redundant rows. Trims whitespace; empty string is stored as `null`. Inline form on `/admin/bookings/:id`, same RBAC as cancel.

### Transfer booking between agents (5q)

`transferBookingAgent({bookingId, toAgentId, reason, includeEarnedKomisi})` in `src/services/bookingAdmin.js`:
- **`Booking.agentSlugCap` is NEVER mutated** — that's the historical URL trail (which `?a=…` slug the visitor first arrived through), kept as audit evidence even when the active agent rotates. Only `Booking.agentId` changes.
- Active bookings only (rejects CANCELLED/REFUNDED with 409). No-op if `toAgentId === current agentId`.
- `toAgentId = null` means transfer to **Kantor Pusat** (no agent).
- Komisi handling by status:
  - `PENDING` → re-points to new agent. **Deleted** when target is Kantor Pusat (KP doesn't earn komisi).
  - `EARNED` → **stays with original agent by default** (they earned it). Caller can opt-in with `includeEarnedKomisi=true` to transfer — admin discretion only.
  - `PAID` → never touched (already disbursed).
  - `CANCELLED` → never touched (history).
- Audit `Booking UPDATE` includes `{transfer: true, reason, agentSlugCap (emphasised unchanged), komisi: {pendingMoved, pendingDeleted, earnedMoved, earnedKept}}`.
- Reason required (min 3 chars). RBAC: OWNER/SUPERADMIN/MANAJER_OPS only.

## Maintenance jobs

Three ops jobs, all sharing the same pattern: pure service in `src/services/`, thin CLI wrapper in `src/jobs/` that disconnects Prisma and exits, plus an OWNER-only HTTP trigger under `/api/admin/jobs/*` for manual runs.

| Job | CLI | HTTP trigger | Service | What it does |
|-----|-----|--------------|---------|--------------|
| expire-docs | `npm run job:expire-docs` | `POST /api/admin/jobs/expire-docs` | `expireOverdueDocuments` | `JemaahDocument` rows with `expiresAt < now` and non-EXPIRED status → EXPIRED + audit |
| expire-intents (5uu) | `npm run job:expire-intents` | `POST /api/admin/jobs/expire-intents` | `expireStaleIntents` | `PaymentIntent` rows with `expiresAt < now` and status IN (CREATED, PENDING) → EXPIRED + audit |
| send-notifications | `npm run job:send-notifications` | `POST /api/admin/jobs/send-notifications` | `processPendingNotifications` | Dispatch all PENDING notifs + FAILED rows whose backoff window elapsed (5nn) |

All three are **idempotent** — re-running on an empty queue is a no-op. Terminal statuses are always skipped (e.g. `expire-intents` never touches SETTLED/CANCELLED/FAILED — the 5pp "terminal frozen" invariant).

**Job-run logging + `/api/health` freshness**. Both the CLI scripts and the HTTP triggers route through `runJob(name, fn)` in `src/lib/jobRunner.js` — writes a `JobRun` row on start, patches it on finish with `ok` + `durationMs` + derived counters (`scanned`, `affected` from `expired`/`sent`, `errors`). `/api/health` calls `getJobFreshness()` which returns the latest successful run per known job + an `ok` flag derived from `age <= 2 × EXPECTED_INTERVAL_MS[name]`. Aggregate `status` flips to `"degraded"` when DB is down OR any job is stale — external uptime monitors can alert on that single field. **Tests deliberately bypass `runJob` and call services directly**, so test fixtures never pollute the freshness log.

Production deployment artifacts live in `deploy/` (see `deploy/DEPLOYMENT.md`):
- `deploy/crontab.example` — drop into `/etc/cron.d/religio-pro`
- `deploy/systemd/religio-{expire-docs,expire-intents,send-notifications}.{service,timer}` — systemd alternative (preferred on modern hosts; uses `OnUnitInactiveSec` to prevent overlap, sandboxing flags for least-privilege)
- `deploy/logrotate.example` — `/etc/logrotate.d/religio-pro`

**Set `NOTIF_WORKER_DISABLED=true` in production `.env` when cron/systemd drives the notif queue** — otherwise the in-process worker AND the scheduler both dispatch, doubling delivery.

Daily for docs (expiry granularity is days), 10-min for intents (Snap sessions ~1h, "stuck for a few min" is fine), 2-min for notifs (near-real-time delivery). The in-process notif worker (5cc) handles notif dispatch automatically when the dev server is running — system cron is only needed for production deploys with `NOTIF_WORKER_DISABLED=true`.

**Audit signature for system jobs**: `actorEmail: 'system'` + `actorRole: null` (Role enum has no SYSTEM member). The job-specific marker goes in the `after` payload — e.g. `autoExpired: true` for both expire-* jobs. This distinguishes automated transitions from manual admin actions (5qq stuck-intent cancel sets `adminCancel: true` instead).

## Notifications (5y)

`src/services/notifications.js` is a queue-based, channel-pluggable notification subsystem. Layout:

- **Model** `Notification(type, channel, status, recipientEmail/Phone/UserId, subject, body, payload, relatedEntity, relatedEntityId, sentAt, error, attemptCount, nextRetryAt, lastAttemptAt, readAt)` — durable queue + dispatch log. `readAt` (5rr) is independent of dispatch: a SKIPPED row can still be "read" by the jemaah seeing it in their inbox.
- **`enqueueNotification()`** — writes a row in `PENDING`. **Never throws**; failed inserts are logged to console and the caller continues. Recipient-missing for the chosen channel auto-marks the row `SKIPPED` with a reason — visible in the admin viewer, not silently dropped.
- **Per-channel opt-out (5jj)** — `enqueueNotification` accepts an optional `recipientUserId`. When present, it looks up that user's `JemaahProfile.{notifEmail, notifWa}` booleans (default `true`); if the channel is opted out, the row is created with `status=SKIPPED` + `error="recipient opted out of <CHANNEL> notifications"` + `sentAt=now`. The opt-out check runs *before* the recipient-missing check, so an opted-out user with a valid phone/email still gets a clear "opted out" reason in the queue viewer. All notif helpers (`notifyBookingCreated`, `notifyPaymentReceived`, `notifyRefundIssued`) thread the userId via `booking.jemaah?.userId ?? booking.jemaahUserId`. Admin-side notif types (e.g. `notifyCancelRequested`) skip this — opt-out is jemaah-only, never gates admin alerts.
- **`recipientUserId` is also the inbox key (5ll)** — same field doubles as the filter for `/saya/notifications`. **Admin-targeted notifs MUST omit `recipientUserId`** (set it to null) so they never appear in any jemaah's inbox. The composite index `[recipientUserId, createdAt]` keeps the per-user list query cheap as the table grows. Rule of thumb when adding a new notify helper: if the recipient is the jemaah, pass `recipientUserId`; if it's an admin/agent/system, leave it out.
- **`dispatchNotification()`** — looks up a per-channel sender, runs it, persists result (`SENT` / `FAILED` / `SKIPPED`). Every dispatch (success or fail) increments `attemptCount` and stamps `lastAttemptAt`. SENT and SKIPPED are terminal (`nextRetryAt=null`).
- **Retry with exponential backoff (5nn)** — when dispatch returns FAILED, the row stays as status=`FAILED` but gets `nextRetryAt = now + BACKOFF_MS[attemptCount-1]`. Schedule: **1 min → 5 min → 30 min → 2 h → 12 h** (`MAX_ATTEMPTS = 5`). After the 5th failed attempt, `nextRetryAt=null` and the row is **terminally FAILED** — the queue worker stops picking it up. `processPendingNotifications` query is `status=PENDING OR (status=FAILED AND nextRetryAt<=now AND attemptCount<MAX_ATTEMPTS)`; composite index `[status, nextRetryAt]` keeps it cheap. **FAILED is therefore not a terminal status by itself** — the combination of `status=FAILED + nextRetryAt=null` (or `attemptCount>=MAX`) is what makes it terminal. The admin "SEND NOW" button (relabelled "RETRY" once `attemptCount>0`) **resets `attemptCount=0` + clears `nextRetryAt`** before dispatching, so an operator can give an exhausted row a fresh budget without DB surgery.
- **Sender table** `SENDERS = { CONSOLE, EMAIL, WA }` — default is `defaultConsoleSender` (logs `[notif:CHANNEL] → recipient · type`). Production adapters live in `src/lib/senders/` and are wired via `bootstrapNotifSenders()` (5kk) — see next bullet.
- **Production adapters (5kk)** — `bootstrapNotifSenders()` in `src/lib/notifBootstrap.js` registers real senders **per-channel** based on env presence: `FONNTE_TOKEN` wires WA (Fonnte HTTP API, built-in `fetch`); `SMTP_HOST + SMTP_FROM` wires EMAIL (nodemailer). Missing env = stay on console default (correct for dev/smoke). Called from **both** `server.js` (boot) and `src/jobs/send-notifications.js` (CLI cron), so the CLI doesn't silently fall back to console when system cron runs the queue. The bootstrap is idempotent — repeated calls are safe. **Fonnte phone normalisation**: stripped to digits, leading `0` swapped to `62`; numbers already starting with `62` pass through. This is the only place phone format matters — DB phones can stay in any common ID format. Fonnte quirk: returns HTTP 200 even on logical failure, so success requires the response body to have `status: true`; otherwise we surface `body.reason` as the SMTP/WA `error`.
- **Template engine (5bb)** — body + subject come from file-based JSON templates at `src/notifications/templates/<TYPE>__<CHANNEL>.json` with `{{var}}` placeholders. Service helpers (`notifyBookingCreated`, etc.) just compute a `vars` object and call `renderTemplate(type, channel, vars)`. Templates are cached in-memory after first read; edit + restart dev to reload. **Missing template files throw** (loud failure beats silent empty body). Missing `vars` keys render as empty strings (defensive). To localise per language later, rename to `<TYPE>__<CHANNEL>__<locale>.json` and add a locale param to `renderTemplate`.
- **Event hooks (non-blocking)** — these wrap the enqueue in try/catch so notif failure cannot abort the originating DB write:
  - `createBooking` → `notifyBookingCreated` (email + WA to jemaah)
  - `recordPayment` → `notifyPaymentReceived` (WA to jemaah)
  - `issueRefund` → `notifyRefundIssued` (WA to jemaah; body adapts to partial vs full refund — full means booking moved to REFUNDED, partial means it stays CANCELLED)
  - `requestCancelByJemaah` → `notifyCancelRequested` (email to **every ACTIVE OWNER/SUPERADMIN/MANAJER_OPS with an email** — fan-out, one notif row per admin so each can be retried independently)
  - `handleMidtransNotification` (on SETTLED) → `notifyPaymentSettledAdmin` (5yy — email fan-out to same admin set; lets ops know real money arrived without polling `/admin/payment-intents`. NEVER fires on duplicate webhooks — guarded by the `intent.paymentId` idempotency check upstream)
  - `createPayout` → `notifyPayoutCreated` (WA to agent)
- **CLI + HTTP trigger** — `npm run job:send-notifications` (cron-friendly) and `POST /api/admin/jobs/send-notifications` (OWNER) both call `processPendingNotifications({limit:100})`. Re-running on an empty queue is a no-op. Per-row `POST /admin/notifications/:id/send` dispatches one immediately, useful for testing.
- **In-process worker (5cc)** — `src/lib/notifWorker.js` runs the same `processPendingNotifications` on a `setInterval` (default 30 s) inside the dev server process. Started from `server.js` after `app.listen`. Override with `NOTIF_WORKER_INTERVAL_MS=<ms>` env var; disable entirely with `NOTIF_WORKER_DISABLED=true` (production deploys that prefer system cron should set this). A `running` flag guards against tick overlap when processing > interval; ticks log only when work was actually done, so the idle case stays quiet. `stopNotifWorker()` runs on SIGTERM/SIGINT before `server.close()` to drain cleanly. **Retries (5nn) ride this same worker for free** — every 30 s tick re-checks any FAILED row whose `nextRetryAt` has elapsed, so the in-process loop doubles as the retry scheduler. With backoff floors at 1 min, the 30 s cadence is plenty granular.

Production cron example (every 2 minutes for near-real-time delivery):
```cron
*/2 * * * * cd /path/to/travel && npm run job:send-notifications >> /var/log/religio/notif.log 2>&1
```

For real WhatsApp delivery, **Fonnte** (Indonesian provider, easier than Meta WhatsApp Business API) is the wired adapter — drop `FONNTE_TOKEN` (device token from Fonnte dashboard) into `.env` and restart. For email, the wired adapter is **nodemailer** — set `SMTP_HOST` + `SMTP_FROM` (+ optional `SMTP_USER/PASS/PORT/SECURE`). When wired, boot logs `[notif] WA sender = Fonnte` / `[notif] EMAIL sender = SMTP host:port`; if those lines are missing, you're still on console default.

## Analytics

`src/services/analytics.js` exposes `getAgentFunnel(agentId, opts)`, `getLeadSourceBreakdown(agentId, opts)`, `getDailyActivity(agentId, opts)`. Pass `agentId=null` for global (admin) view. `opts = {from, to}` filter on `createdAt`; `resolveRange()` handles defaults (last 30 days), swap (from > to), and invalid date fallback. `getDailyActivity` caps at 366 days to keep SVG sparklines readable.

## Static design package

Seven HTML files plus one shared stylesheet. The whole system pivots on `shared/tokens.css`.

- `index.html` — the **Hub**. Curated entry point with live in-tile previews (miniature versions of each downstream screen, scaled with `transform: scale()`).
- `design-system.html` — Foundations: color tokens, type scale, spacing, components. This is the visual contract; every other screen consumes it.
- `screens/landing.html` — Public marketing page.
- `screens/paket-detail.html` — Auto-generated sales landing per-package. **The dynamic version at `/p/:slug` is the canonical one** — this static file is kept as a design reference.
- `screens/admin-dashboard.html` — Static mockup for the HQ dashboard (1440px desktop). The dynamic `/admin` is built on this.
- `screens/agen-crm.html` — Static mockup for agent CRM (1440px desktop). Dynamic `/agen` mirrors structure.
- `screens/crew-app.html`, `screens/jemaah-app.html` — Mobile app mockups (iOS 393×852). Not yet wired to backend.

### The token contract

`shared/tokens.css` defines:
- CSS custom properties for the **Onyx + Gold + Cream** palette (`--ink-*`, `--gold-*`, `--cream-*`), jewel-tone semantics (`--emerald`, `--ruby`, `--sapphire`, `--amber`), and currency hues.
- Typography stack: Cormorant Garamond (display), Plus Jakarta Sans (body), JetBrains Mono (mono/eyebrow), Amiri (Arabic) — loaded from Google Fonts via `@import`.
- Spacing (`--s-1`…`--s-10`), radius (`--r-xs`…`--r-full`), shadows, hairlines, motion easings, and layout container width.
- Component primitives: `.btn` (+ `--primary`/`--ghost`/`--outline-gold`/`--danger`/sizes), `.badge` (+ semantic variants), `.card`, `.input`, `.label`, `.eyebrow`, `.brand-mark`, `.ornament-corners`, dividers, and a custom scrollbar.

**Always reuse these tokens and primitives** instead of introducing new color/spacing values or duplicating button/badge styles. Per-page `<style>` blocks should only define page-specific layout, not redefine the palette.

### Path conventions

- Root-level files (`index.html`, `design-system.html`) link to `shared/tokens.css`.
- Files in `screens/` link to `../shared/tokens.css`.
- Dynamic EJS templates link to `/shared/tokens.css` (Express serves the same file).
- Hub previews reference downstream screens via `screens/<name>.html`; in-screen navigation back to the hub uses `../index.html`.

### Body label convention

Every page sets `<body data-screen-label="NN Name">` (e.g. `"02 Admin Dashboard"`). This is the canonical screen identifier — preserve it when adding new screens, and increment numerically.

### In-tile preview pattern (Hub)

`index.html` embeds scaled-down versions of each screen inside `.tile__visual > .preview > .preview-canvas.pv-*`. Each `.pv-*` block is a self-contained mini-mock built from the same tokens, then shrunk via `transform: scale(0.42)`. When a screen's hero/key surface changes meaningfully, update the corresponding `.pv-*` preview in the hub to match.

## Conventions / invariants

- **Number-input step on Rupiah fields**: use `step="1"` (not `step="100000"`). Cicilan/komisi/payment amounts are often non-round (e.g. `5170000` = 62M/12). Browser blocks form submit with "please enter valid number value" on mismatch — saved data is fine, but UX breaks.
- **MySQL enum sort order** follows declaration order, not alphabetical. For UI lists where "ACTIVE first" matters (paket list, dropdown defaults), do the rank-sort in JS after the Prisma query rather than relying on `orderBy: { status: 'asc' }`. See `STATUS_RANK` in `src/services/adminDashboard.js`.
- **Form-encoded vs JSON endpoints**: browser-facing admin sub-pages use form POST + redirect-after-success. JSON endpoints (under `/api/*`) return errors via the global errorHandler which serializes to JSON. Don't mix: an `/admin/*` route that returns JSON errors will show raw JSON in the browser.
- **Ownership checks** in nested CRUD services (`loadOwnedHotel`, `loadOwnedDay`, `loadOwnedRoom`, `loadOwnedLead`) match the resource's parent FK against the request scope (paketSlug or req.user.agent). 404 if not found, 403 if wrong owner.
- **Audit invariant**: every state-changing service call must write to `AuditLog`. Never delete or update audit rows. Tools to read: `/admin/audit` viewer + audit timeline on booking detail page.
- **`audit()` actor.role is the Prisma `Role` enum** — passing a custom string like `'SYSTEM'` will be rejected by the DB and the audit write fails **silently** (the writer catches errors and only logs to console). For system actors (cron, jobs, internal callers) **omit `role` entirely** — `actorEmail: 'system'` + `actorRole: null` is the convention. See `src/services/expireDocs.js` for the pattern.
- **Skip-audit-on-no-op**: when an update sets a field to its current value, prefer to short-circuit before writing (e.g. `updateBookingNotes` in `src/services/bookingAdmin.js`). This keeps the audit log focused on real state changes; idempotent calls become free.
- **Payment rows are append-only** like AuditLog: refunds create a new row with `amount < 0` and `status=REFUNDED`, never mutate the original `PAID` row. UI must handle negative amounts (ruby colour + `−` prefix) and the `REFUNDED` status badge.
- **Prisma JSON path filters use MySQL syntax**, not Postgres. `where: { after: { path: ['merged'], equals: true } }` (array form, Postgres) is **rejected** at runtime — MySQL needs `path: '$.merged'` (single string with `$.` prefix). Easy to hit when grepping audit logs by JSON content.
- **Anonymous booking always creates a new `JemaahProfile`** (no phone-based dedup at creation time, because phone isn't unique). Dedup happens later, on claim — see `claimBooking` in `src/services/jemaahPortal.js`. Do not add phone-based dedup to the public booking flow without addressing family-shared-phone collisions.
- **`Booking.agentSlugCap` is immutable** — the historical URL-of-origin trail. `Booking.agentId` rotates via `transferBookingAgent`, but `agentSlugCap` stays put forever (even when the original agent's slug gets renamed/deleted). This means "who currently services this booking" and "where this booking originally came from" are two separate facts, and both are queryable.
- **`router.use('/saya', ...)` does NOT match `/api/saya/*`** — Express prefix matching is literal. The `/saya` prefix only covers `/saya`, `/saya/profile`, etc. The `/api/saya/*` paths need `requireAuth + requireRole(...)` applied **inline** per route (see `requireJemaah` spread in `src/routes/jemaahPortal.js`). Otherwise `req.user` is undefined and the route 500s with "Cannot read properties of undefined (reading 'id')".
- **HTML checkbox "unchecked" is absent from `req.body`** — when paired with a 3-state Zod preprocessor (`undefined → no change`), this means an unchecked toggle never persists as `false`. For opt-out semantics where unchecking *must* save `false`, normalise at the route layer **before** validation: `notifWa: req.body?.notifWa ?? false`. The 3-state preprocessor is still right for JSON callers (PATCH semantics), but form POSTs need this fix-up. See `/api/saya/profile` for the pattern.
- **Uploaded files MUST live under a dir in `SENSITIVE_PREFIXES`** — `private/` is blocked from `express.static`, so files are only reachable via auth-checking download routes (5mm). When introducing a new directory that holds user-uploaded or private content, add it to `SENSITIVE_PREFIXES` in `src/app.js` **before** wiring uploads, or `express.static` will serve it. The existing public `uploads/` dir (static design package) is the counter-example — it's deliberately public; never put real user data there.
- **Server-side filename sanitisation is non-negotiable** — `sanitiseBasename()` in `src/lib/docStorage.js` is applied to both the on-disk filename AND the `Content-Disposition` header for downloads. Never let the user's raw `originalname` reach either path: it can contain `../`, control chars, or homoglyphs that confuse the filesystem or trick a downloader. Mime allowlist + size cap are also enforced in two places (multer + service) — keep both layers in sync when adding new types.
- **`recordPayment` is the single source of truth for money math** — admin-recorded payments, gateway webhook settlements (5pp), and any future automation MUST defer to `recordPayment` in `src/services/payment.js` for creating Payment rows + bumping `Booking.paidAmount` + transitioning `Booking.status` + creating `Komisi` on LUNAS. Never inline these calculations elsewhere. The gateway webhook handler in particular looks tempting to special-case (Midtrans tells us the amount + method!) but bypassing `recordPayment` would let gateway-paid bookings skip the LUNAS-triggered komisi creation. Same rule for refunds: always go through `issueRefund` (`src/services/refund.js`).
- **Webhook handlers MUST be idempotent** — external systems (Midtrans, future Fonnte delivery callbacks, etc.) retry on non-200. Always design the handler so the same payload arriving N times produces the same end state as arriving once. The 5pp pattern: guard on a "I already did this work" sentinel (`intent.paymentId != null`) before invoking the side-effect, and return a NOOP result if it's already done. Pair this with signature verification (constant-time compare via `crypto.timingSafeEqual`) so untrusted callers can't poke the handler.
