// Stage 343-345 — reschedule queue + reason code + analytics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  listPendingRescheduleRequests, rescheduleBooking, RESCHEDULE_REASON_CODES,
} from '../src/services/bookingAdmin.js';
import { getRescheduleAnalytics } from '../src/services/rescheduleAnalytics.js';

async function freshPaket(t, tag, { priceIdr = '5000000', kursiTotal = 20 } = {}) {
  const dep = new Date(Date.now() + 60 * 86_400_000);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr }] },
    },
  });
  t.after(async () => {
    const bookings = await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (bookings.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: 'Booking', relatedEntityId: { in: bookings.map((b) => b.id) } },
      });
    }
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S343 — listPendingRescheduleRequests returns pending only', async (t) => {
  const tag = makeTag('s343a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await freshPaket(t, `${tag}-p`);
  const tgt = await freshPaket(t, `${tag}-t`);
  // Pending one
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      rescheduleRequested: true,
      rescheduleRequestedAt: new Date(Date.now() - 6 * 3_600_000),
      rescheduleRequestReason: 'mau pindah',
      rescheduleRequestTargetPaketId: tgt.id,
    },
  });
  // Already RESCHEDULED (terminal) — should NOT appear
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'RESCHEDULED',
      rescheduleRequested: true, // shouldn't happen in real flow, but defensive
    },
  });

  const q = await listPendingRescheduleRequests({});
  // Only the PENDING one in my tag
  const mine = q.rows.filter((r) => r.bookingNo.startsWith(`RP-${tag}`));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].bookingNo, `RP-${tag}-1`);
  assert.equal(mine[0].targetPaket?.title, `Paket ${tag}-t`);
  assert.ok(mine[0].ageHours >= 5);
});

test('S344 — rescheduleBooking accepts + persists reasonCode', async (t) => {
  const tag = makeTag('s344a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await rescheduleBooking({
    req: fakeReq, actor,
    sourceBookingId: b.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
    reasonCode: 'DOCUMENT_DELAY',
  });
  const fresh = await db.booking.findUnique({
    where: { id: b.id },
    select: { status: true, rescheduleReasonCode: true },
  });
  assert.equal(fresh.status, 'RESCHEDULED');
  assert.equal(fresh.rescheduleReasonCode, 'DOCUMENT_DELAY');
});

test('S344 — rejects invalid reasonCode', async (t) => {
  const tag = makeTag('s344b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    rescheduleBooking({
      req: fakeReq, actor,
      sourceBookingId: b.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
      reasonCode: 'BOGUS_CODE',
    }),
    /tidak valid/,
  );
});

test('S344 — RESCHEDULE_REASON_CODES exports the 8 expected codes', () => {
  assert.equal(RESCHEDULE_REASON_CODES.size, 8);
  for (const c of ['JEMAAH_REQUEST', 'DOCUMENT_DELAY', 'HEALTH', 'FINANCIAL', 'PAKET_FULL', 'SCHEDULE_CONFLICT', 'OPERATOR_INITIATED', 'OTHER']) {
    assert.ok(RESCHEDULE_REASON_CODES.has(c), `missing: ${c}`);
  }
});

test('S345 — getRescheduleAnalytics empty envelope', async () => {
  const r = await getRescheduleAnalytics({ days: 1, now: new Date('3000-01-01') });
  assert.equal(r.total, 0);
  assert.deepEqual(r.perPaket, []);
  assert.deepEqual(r.perReason, []);
  assert.deepEqual(r.topPairs, []);
});

test('S345 — getRescheduleAnalytics aggregates per-paket flow + per-reason', async (t) => {
  const tag = makeTag('s345a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  // Reschedule 3 bookings src → tgt with different reasons
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  for (const code of ['DOCUMENT_DELAY', 'DOCUMENT_DELAY', 'HEALTH']) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${Math.random().toString(36).slice(2, 6)}`,
        paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await rescheduleBooking({
      req: fakeReq, actor,
      sourceBookingId: b.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
      reasonCode: code,
    });
  }
  const r = await getRescheduleAnalytics({});
  // Total should at least cover our 3
  assert.ok(r.total >= 3);
  // src paket has net -3 (3 out, 0 in among our bookings, but other tests may add noise)
  const srcRow = r.perPaket.find((p) => p.paketSlug === src.slug);
  assert.ok(srcRow);
  assert.ok(srcRow.out >= 3);
  const tgtRow = r.perPaket.find((p) => p.paketSlug === tgt.slug);
  assert.ok(tgtRow);
  assert.ok(tgtRow.in >= 3);
  // Top pair contains src→tgt with count >= 3
  const pair = r.topPairs.find((p) => p.sourcePaket?.slug === src.slug && p.targetPaket?.slug === tgt.slug);
  assert.ok(pair);
  assert.ok(pair.count >= 3);
  // Reason breakdown should include DOCUMENT_DELAY + HEALTH
  const docDelay = r.perReason.find((p) => p.code === 'DOCUMENT_DELAY');
  assert.ok(docDelay);
  assert.ok(docDelay.count >= 2);
});
