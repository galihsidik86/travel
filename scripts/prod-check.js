#!/usr/bin/env node
// Production readiness check.
//
// Usage:
//   npm run prod:check
//
// Verifies:
//   - Required env vars are set (DATABASE_URL, JWT_SECRET, PUBLIC_BASE_URL,
//     COOKIE_SECURE=true when NODE_ENV=production)
//   - Optional integrations declared if you intended them (VAPID, Fonnte, SMTP)
//   - DB reachable + Prisma migrations applied
//   - private/ writeable for uploads + voucher cache
//   - NOTIF_WORKER_DISABLED=true when running under cron/systemd
//
// Exits 0 if ready, 1 if any blocker. Warnings (yellow) don't fail.

import fs from 'node:fs';
import path from 'node:path';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

let failed = 0;
let warned = 0;
function ok(label, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? DIM + ' — ' + detail + RESET : ''}`);
}
function fail(label, detail = '') {
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ' — ' + RED + detail + RESET : ''}`);
  failed += 1;
}
function warn(label, detail = '') {
  console.log(`  ${YELLOW}!${RESET} ${label}${detail ? DIM + ' — ' + detail + RESET : ''}`);
  warned += 1;
}
function section(name) {
  console.log(`\n${BOLD}${name}${RESET}`);
}

console.log(`${BOLD}Religio Pro — production readiness check${RESET}`);
console.log(`${DIM}Run before first deploy to flag missing config + infra${RESET}`);

const isProd = process.env.NODE_ENV === 'production';
console.log(`\n  NODE_ENV = ${isProd ? GREEN + 'production' + RESET : YELLOW + (process.env.NODE_ENV || '(unset)') + RESET}`);
if (!isProd) {
  warn('Running with NODE_ENV != production', 'most prod-only checks are advisory');
}

// ── Required env ───────────────────────────────────────────────
section('1. Required environment variables');
const REQ = ['DATABASE_URL', 'JWT_SECRET'];
for (const k of REQ) {
  if (process.env[k]) ok(k, k === 'JWT_SECRET' ? `${process.env[k].length} chars` : 'set');
  else fail(k, 'missing');
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  fail('JWT_SECRET too short', `${process.env.JWT_SECRET.length} chars (recommend ≥32)`);
}

// ── Production-only required env ───────────────────────────────
section('2. Production-only configuration');
if (isProd) {
  if (process.env.PUBLIC_BASE_URL && /^https:\/\//.test(process.env.PUBLIC_BASE_URL)) {
    ok('PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL);
  } else if (process.env.PUBLIC_BASE_URL) {
    fail('PUBLIC_BASE_URL', `must start with https:// in prod (got ${process.env.PUBLIC_BASE_URL})`);
  } else {
    fail('PUBLIC_BASE_URL', 'missing — notif deep links + voucher QR + Web Share break without it');
  }
  if (process.env.COOKIE_SECURE === 'true') ok('COOKIE_SECURE', 'true');
  else fail('COOKIE_SECURE', 'must be "true" in production (HTTPS-only cookies)');
  if (process.env.COOKIE_DOMAIN && process.env.COOKIE_DOMAIN !== 'localhost') {
    ok('COOKIE_DOMAIN', process.env.COOKIE_DOMAIN);
  } else {
    warn('COOKIE_DOMAIN', 'still "localhost" or unset — set to your real domain');
  }
} else {
  warn('Skipping prod-only checks', 'set NODE_ENV=production to enable');
}

// ── Optional integrations ──────────────────────────────────────
section('3. Optional integrations (set if you want real delivery)');
const optionalGroups = [
  { name: 'Midtrans payment', keys: ['MIDTRANS_SERVER_KEY', 'MIDTRANS_CLIENT_KEY'], extra: 'unset → fake mode (NEVER deploy to prod)' },
  { name: 'WhatsApp (Fonnte)', keys: ['FONNTE_TOKEN'], extra: 'unset → WA notifs log to console only' },
  { name: 'Email (SMTP)', keys: ['SMTP_HOST', 'SMTP_FROM'], extra: 'unset → EMAIL notifs log to console only' },
  { name: 'Web Push (VAPID)', keys: ['VAPID_PUBLIC', 'VAPID_PRIVATE', 'VAPID_CONTACT'], extra: 'unset → push logs to console only — run `npm run vapid:generate`' },
  { name: 'Public admin contact (S354)', keys: ['PUBLIC_ADMIN_WA', 'PUBLIC_ADMIN_PHONE'], extra: 'unset → jemaah quick-contact only shows agent number' },
  { name: 'Redis rate-limit', keys: ['REDIS_URL'], extra: 'unset → in-memory bucket (single-instance only)' },
];
for (const g of optionalGroups) {
  const set = g.keys.filter((k) => !!process.env[k]);
  if (set.length === g.keys.length) ok(g.name, 'fully configured');
  else if (set.length === 0) warn(g.name, g.extra);
  else warn(g.name, `partial — set ${g.keys.filter((k) => !process.env[k]).join(', ')}`);
}

// ── Notif worker mode ─────────────────────────────────────────
section('4. Notification worker mode');
if (process.env.NOTIF_WORKER_DISABLED === 'true') {
  ok('NOTIF_WORKER_DISABLED=true', 'cron/systemd MUST drive the queue (see deploy/crontab.example)');
} else {
  if (isProd) {
    fail('NOTIF_WORKER_DISABLED', 'must be "true" in production OR you risk double-dispatch');
  } else {
    warn('NOTIF_WORKER_DISABLED unset', 'fine for dev (in-process worker runs every 30s)');
  }
}

// ── Filesystem ────────────────────────────────────────────────
section('5. Filesystem');
const projectRoot = path.resolve(import.meta.dirname, '..');
const requiredDirs = [
  ['private', 'doc + voucher + incident uploads'],
  ['private/docs', 'jemaah document files'],
  ['private/voucher-cache', 'S149 voucher PDF cache'],
  ['private/incidents', 'S373 incident photo evidence'],
];
for (const [rel, purpose] of requiredDirs) {
  const abs = path.join(projectRoot, rel);
  try {
    fs.mkdirSync(abs, { recursive: true });
    // Try writing a probe file
    const probe = path.join(abs, '.prod-check-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    ok(rel + '/', purpose);
  } catch (err) {
    fail(rel + '/', `not writable — ${err.message}`);
  }
}

// ── DB connectivity + migrations ───────────────────────────────
section('6. Database');
let dbOk = false;
try {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const rows = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations');
  const n = Number(rows[0]?.n || rows[0]?.N || 0);
  ok('Connection', `Prisma client connected, ${n} migrations applied`);
  if (n === 0) fail('Migrations', 'no migrations applied — run `npm run db:migrate`');
  // Verify a small known model exists
  await db.user.count();
  ok('User table', 'reachable');
  dbOk = true;
  await db.$disconnect();
} catch (err) {
  fail('Database connection', err.message);
}

// ── Health endpoint (only if server is running locally) ───────
section('7. Self-check (skipped — start the server + curl /api/health to verify)');
console.log(`  ${DIM}This script doesn't start the server. After deploy, verify:${RESET}`);
console.log(`  ${DIM}  curl https://YOUR-DOMAIN/api/health${RESET}`);
console.log(`  ${DIM}  Expected: 200 OK with status=ok + all job freshness markers OK${RESET}`);

// ── Summary ────────────────────────────────────────────────────
console.log('');
console.log(BOLD + '─'.repeat(60) + RESET);
if (failed === 0) {
  console.log(`${GREEN}${BOLD}READY${RESET} · ${warned} warning${warned === 1 ? '' : 's'}`);
  if (warned > 0) console.log(`${DIM}Review warnings above — they're advisory but worth fixing.${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${BOLD}NOT READY${RESET} · ${failed} blocker${failed === 1 ? '' : 's'} · ${warned} warning${warned === 1 ? '' : 's'}`);
  console.log(`${DIM}Fix red ✗ items before deploying. See deploy/DEPLOYMENT.md for setup steps.${RESET}`);
  process.exit(1);
}
