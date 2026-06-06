// Religio Pro — Playwright auto-capture for the deck.
//
// Usage:   node scripts/capture-screenshots.js
// Requires: dev server running on http://localhost:3001 (or BASE_URL env).
//
// Captures full-page screenshots of every UI surface the deck references
// and saves them into presentation/screenshots/ with the exact filenames
// the deck generator expects. Then re-running:
//
//   node scripts/build-presentation.js
//
// replaces the placeholder boxes with the captured images.

import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { db } from '../src/lib/db.js';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const OUT = path.resolve('presentation/screenshots');
fs.mkdirSync(OUT, { recursive: true });

// Default desktop viewport — wider than 16:9 slide ratio so full-page renders cleanly.
const DESKTOP = { width: 1440, height: 900 };

// Roles → seed credentials. JEMAAH + MUTHAWWIF resolved dynamically since
// the seed creates them under non-deterministic emails (siti@example.com
// was reset earlier in dev; MUTHAWWIF created by smoke fixtures).
const CREDS = {
  OWNER:    { email: 'owner@religio.pro', password: 'owner12345' },
  AGEN:     { email: 'ahmad@religio.pro',  password: 'ahmad12345' },
  JEMAAH:   { email: 'siti@example.com',  password: 'siti12345' },
  // MUTHAWWIF resolved at runtime — see findMuthawwif
};

async function findMuthawwif() {
  const u = await db.user.findFirst({
    where: { role: 'MUTHAWWIF', status: 'ACTIVE', deletedAt: null },
    select: { email: true },
  });
  return u?.email || null;
}

async function findFirstPaketSlug() {
  // Prefer the seed paket which has rich data (hotels/days/bookings) over
  // smoke fixtures left around from tests. Fall back to whatever exists.
  const preferred = await db.paket.findUnique({
    where: { slug: 'ramadhan-aqsa-2026' },
    select: { slug: true, deletedAt: true },
  });
  if (preferred && !preferred.deletedAt) return preferred.slug;
  const any = await db.paket.findFirst({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { slug: true, _count: { select: { bookings: true } } },
    orderBy: [{ bookings: { _count: 'desc' } }, { departureDate: 'asc' }],
  });
  return any?.slug || 'ramadhan-aqsa-2026';
}

async function findFirstBookingId() {
  const b = await db.booking.findFirst({
    where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  return b?.id || null;
}

async function findFirstPayoutId() {
  const p = await db.komisiPayout.findFirst({
    select: { id: true },
    orderBy: { paidAt: 'desc' },
  });
  if (p) return p.id;
  // No payout exists — create a demo one so the slip screenshot renders.
  // Tagged so it can be identified and cleaned up if needed.
  const agent = await db.agentProfile.findFirst({ select: { id: true } });
  const owner = await db.user.findFirst({ where: { email: 'owner@religio.pro' }, select: { id: true } });
  if (!agent || !owner) return null;
  const demo = await db.komisiPayout.create({
    data: {
      payoutNo: `PO-DEMO-${Date.now()}`,
      agentId: agent.id, amount: '2500000', currency: 'IDR',
      method: 'TRANSFER', reference: 'BCA 1234567890',
      notes: 'Demo payout untuk screenshot deck — boleh dihapus',
      paidAt: new Date(), paidById: owner.id,
    },
  });
  console.log(`  ℹ no payout in DB — created demo ${demo.payoutNo}`);
  return demo.id;
}

// Login by form-post — Playwright handles cookies through the context.
async function loginAs(context, role, email, password) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  // Submit + wait for the destination URL (302 → role-specific).
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 10_000 }),
    page.click('button[type=submit]'),
  ]);
  await page.close();
  return context;
}

async function capture(context, url, filename, { fullPage = true, waitFor = null } = {}) {
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 5_000 }).catch(() => {});
  // Give late-rendered SVG charts a tick to settle.
  await page.waitForTimeout(400);
  const target = path.join(OUT, filename);
  await page.screenshot({ path: target, fullPage });
  console.log(`  ✓ ${filename}  (${url})`);
  await page.close();
}

async function captureMobile(context, url, filename) {
  const mobileCtx = await context.browser().newContext({
    ...devices['iPhone 14 Pro'],
    storageState: await context.storageState(),
  });
  const page = await mobileCtx.newPage();
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, filename), fullPage: true });
  console.log(`  ✓ ${filename}  (${url}) [mobile]`);
  await mobileCtx.close();
}

async function main() {
  console.log(`\n→ Capturing screenshots from ${BASE}\n`);

  // Resolve dynamic identifiers before launching the browser.
  const [muthawwifEmail, paketSlug, bookingId, payoutId] = await Promise.all([
    findMuthawwif(),
    findFirstPaketSlug(),
    findFirstBookingId(),
    findFirstPayoutId(),
  ]);

  const browser = await chromium.launch({ headless: true });
  try {
    // 1. Public landing — no auth.
    {
      const ctx = await browser.newContext({ viewport: DESKTOP });
      try {
        await capture(ctx, `/p/${encodeURIComponent(paketSlug)}?a=ahmad-w`, '01-public-landing.png');
      } finally { await ctx.close(); }
    }

    // 2. JEMAAH portal.
    {
      const ctx = await browser.newContext({ viewport: DESKTOP });
      try {
        await loginAs(ctx, 'JEMAAH', CREDS.JEMAAH.email, CREDS.JEMAAH.password);
        await capture(ctx, '/saya', '02-jemaah-portal.png');
        await captureMobile(ctx, '/saya', '06-mobile-pwa.png');
      } catch (err) {
        console.warn('  ⚠ JEMAAH login skipped:', err.message);
      } finally { await ctx.close(); }
    }

    // 3. AGEN portal.
    {
      const ctx = await browser.newContext({ viewport: DESKTOP });
      try {
        await loginAs(ctx, 'AGEN', CREDS.AGEN.email, CREDS.AGEN.password);
        await capture(ctx, '/agen?tab=leads', '03-agen-crm.png');
      } catch (err) {
        console.warn('  ⚠ AGEN login skipped:', err.message);
      } finally { await ctx.close(); }
    }

    // 4. MUTHAWWIF portal.
    if (muthawwifEmail) {
      const ctx = await browser.newContext({ viewport: DESKTOP });
      try {
        await loginAs(ctx, 'MUTHAWWIF', muthawwifEmail, 'smoke12345');
        await capture(ctx, '/crew', '04-crew-portal.png');
      } catch (err) {
        console.warn(`  ⚠ MUTHAWWIF login (${muthawwifEmail}) failed:`, err.message);
      } finally { await ctx.close(); }
    } else {
      console.warn('  ⚠ No MUTHAWWIF user in DB — skipping crew screenshot.');
    }

    // 5-10. OWNER pages.
    {
      const ctx = await browser.newContext({ viewport: DESKTOP });
      try {
        await loginAs(ctx, 'OWNER', CREDS.OWNER.email, CREDS.OWNER.password);

        await capture(ctx, '/admin?tab=overview', '05-admin-overview.png');
        await capture(ctx, `/admin/manifest/${encodeURIComponent(paketSlug)}/print`, '07-print-manifest.png');

        if (bookingId) {
          await capture(ctx, `/admin/bookings/${bookingId}/print`, '08-print-voucher.png');
        } else {
          console.warn('  ⚠ No booking in DB — skipping 08-print-voucher.png');
        }

        if (payoutId) {
          await capture(ctx, `/admin/payouts/${payoutId}/print`, '09-print-slip.png');
        } else {
          console.warn('  ⚠ No payout in DB — skipping 09-print-slip.png');
        }

        // Leaderboard panel is inside the overview tab. Same URL as 05 but
        // anchored to the leaderboard for clarity in the deck.
        await capture(ctx, '/admin?tab=overview#leaderboard', '10-leaderboard.png');
      } catch (err) {
        console.warn('  ⚠ OWNER captures skipped:', err.message);
      } finally { await ctx.close(); }
    }
  } finally {
    await browser.close();
    await db.$disconnect();
  }

  // Summary
  const captured = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'));
  console.log(`\n${captured.length} screenshots in ${OUT}`);
  console.log(`Now re-run:  node scripts/build-presentation.js  to embed them.\n`);
}

main().catch((err) => {
  console.error('Capture crashed:', err);
  db.$disconnect();
  process.exit(1);
});
