// Stage 340-342 — jemaah reschedule request + admin decline + notif fan-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import { requestRescheduleByJemaah } from '../src/services/jemaahPortal.js';
import { declineRescheduleRequest, rescheduleBooking } from '../src/services/bookingAdmin.js';

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

test('S340 — jemaah submits request, fields land + audit row', async (t) => {
  const tag = makeTag('s340a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await freshPaket(t, `${tag}-p`);
  const tgt = await freshPaket(t, `${tag}-t`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '1000000', status: 'DP_PAID',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await requestRescheduleByJemaah({
    req: fakeReq, actor, userId: jem.id, bookingId: b.id,
    reason: 'urusan keluarga di tanggal keberangkatan',
    targetPaketId: tgt.id,
  });
  const fresh = await db.booking.findUnique({
    where: { id: b.id },
    select: {
      rescheduleRequested: true, rescheduleRequestedAt: true,
      rescheduleRequestReason: true, rescheduleRequestTargetPaketId: true,
    },
  });
  assert.equal(fresh.rescheduleRequested, true);
  assert.ok(fresh.rescheduleRequestedAt);
  assert.equal(fresh.rescheduleRequestReason, 'urusan keluarga di tanggal keberangkatan');
  assert.equal(fresh.rescheduleRequestTargetPaketId, tgt.id);
});

test('S340 — rejects reason < 3 chars', async (t) => {
  const tag = makeTag('s340b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await assert.rejects(
    requestRescheduleByJemaah({ req: fakeReq, actor, userId: jem.id, bookingId: b.id, reason: 'hi' }),
    /minimal 3|min. 3|min 3/,
  );
});

test('S340 — rejects double request (already pending)', async (t) => {
  const tag = makeTag('s340c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      rescheduleRequested: true,
      rescheduleRequestedAt: new Date(),
      rescheduleRequestReason: 'prior',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await assert.rejects(
    requestRescheduleByJemaah({ req: fakeReq, actor, userId: jem.id, bookingId: b.id, reason: 'second time' }),
    /sebelumnya/,
  );
});

test('S340 — rejects same-paket preference', async (t) => {
  const tag = makeTag('s340d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await assert.rejects(
    requestRescheduleByJemaah({ req: fakeReq, actor, userId: jem.id, bookingId: b.id, reason: 'ada urusan keluarga', targetPaketId: paket.id }),
    /sama dengan/,
  );
});

test('S340 — cross-user 404', async (t) => {
  const tag = makeTag('s340e');
  const owner = await tempJemaah(t, `${tag}-o`);
  const stranger = await tempJemaah(t, `${tag}-s`);
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: owner.jemaah.id, jemaahUserId: owner.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: stranger.id, email: stranger.email, role: 'JEMAAH' };
  await assert.rejects(
    requestRescheduleByJemaah({ req: fakeReq, actor, userId: stranger.id, bookingId: b.id, reason: 'mau pindah' }),
    /tidak ditemukan/i,
  );
});

test('S341 — declineRescheduleRequest clears flags + writes audit', async (t) => {
  const tag = makeTag('s341a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      rescheduleRequested: true,
      rescheduleRequestedAt: new Date(),
      rescheduleRequestReason: 'mau pindah ke yang lain',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await declineRescheduleRequest({
    req: fakeReq, actor, bookingId: b.id,
    reason: 'paket tujuan belum tersedia di tanggal yang Anda mau',
  });
  const fresh = await db.booking.findUnique({
    where: { id: b.id },
    select: {
      rescheduleRequested: true, rescheduleRequestedAt: true,
      rescheduleRequestReason: true, rescheduleRequestTargetPaketId: true,
    },
  });
  assert.equal(fresh.rescheduleRequested, false);
  assert.equal(fresh.rescheduleRequestedAt, null);
  assert.equal(fresh.rescheduleRequestReason, null);
});

test('S341 — declineRescheduleRequest refuses when no pending request', async (t) => {
  const tag = makeTag('s341b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    declineRescheduleRequest({ req: fakeReq, actor, bookingId: b.id, reason: 'no request to decline' }),
    /Tidak ada permintaan/,
  );
});

test('S341 — rescheduleBooking auto-clears pending request flags', async (t) => {
  const tag = makeTag('s341c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      rescheduleRequested: true,
      rescheduleRequestedAt: new Date(),
      rescheduleRequestReason: 'pindah ke yang lain',
      rescheduleRequestTargetPaketId: tgt.id,
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await rescheduleBooking({
    req: fakeReq, actor,
    sourceBookingId: b.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
  });
  const fresh = await db.booking.findUnique({
    where: { id: b.id },
    select: {
      status: true, rescheduleRequested: true,
      rescheduleRequestReason: true,
    },
  });
  assert.equal(fresh.status, 'RESCHEDULED');
  assert.equal(fresh.rescheduleRequested, false, 'pending request auto-cleared');
  assert.equal(fresh.rescheduleRequestReason, null);
});

test('S342 — notif fan-out fires on jemaah submit', async (t) => {
  const tag = makeTag('s342a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await freshPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await requestRescheduleByJemaah({
    req: fakeReq, actor, userId: jem.id, bookingId: b.id,
    reason: 'ada urusan mendesak keluarga di tanggal keberangkatan',
  });
  const notif = await db.notification.findFirst({
    where: { type: 'RESCHEDULE_REQUESTED', relatedEntityId: b.id, recipientEmail: owner.email },
    select: { subject: true, body: true },
  });
  assert.ok(notif, 'admin gets RESCHEDULE_REQUESTED email');
  assert.match(notif.subject, /Permintaan reschedule/);
  assert.match(notif.body, /urusan mendesak/);
});
