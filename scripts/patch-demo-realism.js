// =============================================================
// Religio Pro — demo-realism patch #2
//
// Fixes found by visually reviewing /admin overview + /agen CRM
// screenshots against production after the initial
// seed-demo-realistic.js run:
//
//   A. A pre-existing (pre-dates this session) unresolved
//      LOST_JEMAAH incident sitting OPEN for 15+ days — alarming
//      clutter on the "Perlu perhatian" panel for a demo.
//   B. Admin users' "recently viewed" trail (S255) pointed at the
//      "Smoke In-Trip Paket S320" rows removed by the cleanup in
//      seed-demo-realistic.js — now 404s when clicked.
//   C. "Konversi paket" panel showed 127%-1300% conversion because
//      bookings were seeded directly via Prisma with zero matching
//      PaketView (page-visit) rows.
//   D. Cancel/refund analytics showed 0% even though real
//      cancelled/refunded bookings exist — they were backdated
//      ~150+ days, outside every 90-day rolling window the
//      analytics panels use.
//
// Usage: node --env-file-if-exists=.env scripts/patch-demo-realism.js
// =============================================================

import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const db = new PrismaClient();

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function daysAgo(n) { return new Date(Date.now() - n * 86400_000); }
function idr(n) { return Math.round(n).toFixed(2); }
function localYmd(d) { return d.toISOString().slice(0, 10); }

const MALE_FIRST = ['Ahmad', 'Bambang', 'Hendra', 'Joko', 'Rizki', 'Yusuf', 'Wahyu', 'Slamet', 'Iwan'];
const FEMALE_FIRST = ['Siti', 'Dewi', 'Fitriani', 'Yuli', 'Sri', 'Rina', 'Sarah', 'Indah', 'Maya'];
const LAST = ['Wibowo', 'Santoso', 'Kusuma', 'Hidayat', 'Susanto', 'Wijaya', 'Pratama', 'Rahman', 'Firdaus'];
function genName() {
  const isMale = Math.random() < 0.5;
  return `${pick(isMale ? MALE_FIRST : FEMALE_FIRST)} ${pick(LAST)}`;
}
const usedPhones = new Set();
function genPhone() {
  const prefixes = ['0811', '0812', '0813', '0821', '0822', '0852', '0878'];
  let phone;
  do { phone = `${pick(prefixes)}-${randInt(1000, 9999)}-${randInt(1000, 9999)}`; } while (usedPhones.has(phone));
  usedPhones.add(phone);
  return phone;
}
async function nextBookingNo(year) {
  const prefix = `RP-${year}-`;
  const count = await db.booking.count({ where: { bookingNo: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(5, '0')}`;
}

async function main() {
  // ── A. Resolve the stale unresolved incident ────────────────
  console.log('── A. Stale incident ──');
  const stale = await db.incident.findMany({ where: { status: { not: 'RESOLVED' } } });
  for (const inc of stale) {
    await db.incident.update({
      where: { id: inc.id },
      data: {
        status: 'RESOLVED',
        ackedAt: inc.ackedAt ?? daysAgo(14),
        ackedById: inc.ackedById,
        resolvedAt: new Date(),
        resolution: 'Ditutup saat pembersihan data demo — insiden lama dari sesi pengujian, jemaah sudah dikonfirmasi aman.',
      },
    });
    console.log(`  resolved incident ${inc.id} (${inc.type})`);
  }
  if (!stale.length) console.log('  none found');

  // ── B. Clear stale "recently viewed" admin trail ─────────────
  console.log('── B. Stale recentEntities ──');
  const withRecent = await db.user.findMany({ where: { NOT: { recentEntities: { equals: null } } }, select: { id: true, email: true } });
  for (const u of withRecent) {
    await db.user.update({ where: { id: u.id }, data: { recentEntities: null } });
    console.log(`  cleared for ${u.email}`);
  }
  if (!withRecent.length) console.log('  none found');

  // ── C. Seed realistic PaketView rows for the two new active paket ──
  console.log('── C. PaketView (visit) rows ──');
  const targets = [
    { slug: 'umroh-reguler-oktober-2026', windowDays: 55, visitCount: 130 },
    { slug: 'umroh-eksekutif-januari-2027', windowDays: 20, visitCount: 55 },
  ];
  const agentSlugs = (await db.agentProfile.findMany({ select: { slug: true } })).map((a) => a.slug);
  let totalViews = 0;
  for (const t of targets) {
    const paket = await db.paket.findUnique({ where: { slug: t.slug } });
    if (!paket) { console.log(`  skip ${t.slug} (not found)`); continue; }
    // Threshold (not >0) — a handful of incidental rows from manual curl/
    // browser checks during verification shouldn't block the bulk seed.
    const existing = await db.paketView.count({ where: { paketId: paket.id } });
    if (existing >= 10) { console.log(`  skip ${t.slug} (already has ${existing} views)`); continue; }
    const rows = [];
    for (let i = 0; i < t.visitCount; i++) {
      const daysBack = randInt(0, t.windowDays);
      const createdAt = daysAgo(daysBack);
      rows.push({
        paketId: paket.id,
        visitorId: crypto.randomBytes(16).toString('hex'),
        dayKey: localYmd(createdAt),
        agentSlug: Math.random() < 0.4 ? pick(agentSlugs) : null,
        referrerHost: Math.random() < 0.5 ? pick(['instagram.com', 'facebook.com', 'google.com', null, null]) : null,
        renderMs: randInt(180, 650),
        createdAt,
      });
    }
    // @@unique([paketId, visitorId, dayKey]) — visitorId is random per row so collisions are practically impossible.
    await db.paketView.createMany({ data: rows });
    totalViews += rows.length;
    console.log(`  ${t.slug}: ${rows.length} visit rows over last ${t.windowDays}d`);
  }
  console.log(`  ${totalViews} total PaketView rows created`);

  // ── D. Add recent (within-90d) cancel/refund activity ────────
  console.log('── D. Recent cancel/refund bookings ──');
  const nearPaket = await db.paket.findUnique({ where: { slug: 'umroh-reguler-oktober-2026' } });
  if (nearPaket) {
    const prices = Object.fromEntries((await db.paketHarga.findMany({ where: { paketId: nearPaket.id } })).map((p) => [p.kelas, Number(p.priceIdr)]));
    const recentEvents = [
      { kelas: 'QUAD', pax: 1, bookedDaysAgo: 22, cancelledDaysAgo: 15, status: 'CANCELLED', paidFrac: 0.15, reasonCode: 'PAYMENT_NOT_RECEIVED' },
      { kelas: 'TRIPLE', pax: 2, bookedDaysAgo: 35, cancelledDaysAgo: 28, status: 'REFUNDED', paidFrac: 0.35, reasonCode: 'JEMAAH_REQUEST' },
    ];
    for (const e of recentEvents) {
      const total = prices[e.kelas] * e.pax;
      const paid = Math.round(total * e.paidFrac);
      const name = genName();
      const jemaah = await db.jemaahProfile.create({ data: { fullName: name, phone: genPhone() } });
      const year = new Date().getFullYear();
      const bookingNo = await nextBookingNo(year);
      const agentSlug = pick(agentSlugs);
      const agent = await db.agentProfile.findUnique({ where: { slug: agentSlug } });
      const booking = await db.booking.create({
        data: {
          bookingNo, paketId: nearPaket.id, jemaahId: jemaah.id,
          agentId: agent?.id ?? null, agentSlugCap: agentSlug,
          kelas: e.kelas, paxCount: e.pax, totalAmount: idr(total), paidAmount: idr(paid),
          currency: 'IDR', status: e.status,
          createdAt: daysAgo(e.bookedDaysAgo),
          cancelledAt: daysAgo(e.cancelledDaysAgo),
          cancelReason: e.reasonCode === 'PAYMENT_NOT_RECEIVED' ? 'Jemaah tidak melanjutkan pembayaran setelah DP.' : 'Permintaan pribadi jemaah — berhalangan berangkat.',
          cancelReasonCode: e.reasonCode,
        },
      });
      if (paid > 0) {
        await db.payment.create({
          data: { bookingId: booking.id, amount: idr(paid), currency: 'IDR', method: pick(['TRANSFER', 'VA']), status: 'PAID', paidAt: daysAgo(e.bookedDaysAgo - 2), gatewayRef: `SEED-PAY-${bookingNo}` },
        });
      }
      if (e.status === 'REFUNDED' && paid > 0) {
        await db.payment.create({
          data: { bookingId: booking.id, amount: idr(-paid), currency: 'IDR', method: 'TRANSFER', status: 'REFUNDED', paidAt: daysAgo(e.cancelledDaysAgo), gatewayRef: `SEED-REFUND-${bookingNo}`, refundReasonCode: 'JEMAAH_REQUEST' },
        });
        await db.booking.update({ where: { id: booking.id }, data: { paidAmount: idr(0) } });
      }
      console.log(`  ${bookingNo} → ${e.status} (${e.cancelledDaysAgo}d ago)`);
    }
  } else {
    console.log('  skip (near paket not found)');
  }

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
