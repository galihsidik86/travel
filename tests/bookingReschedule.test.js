// Stage 337-339 — bookingReschedule service + notif + audit shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import { rescheduleBooking } from '../src/services/bookingAdmin.js';

async function freshPaket(t, tag, { kelas = 'QUAD', priceIdr = '5000000', kursiTotal = 20 } = {}) {
  const dep = new Date(Date.now() + 60 * 86_400_000);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal, status: 'ACTIVE',
      prices: { create: [{ kelas, priceIdr }] },
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

test('S337 — happy path: source goes RESCHEDULED, new booking created with carried paid', async (t) => {
  const tag = makeTag('s337a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const sourcePaket = await freshPaket(t, `${tag}-src`, { priceIdr: '5000000' });
  const targetPaket = await freshPaket(t, `${tag}-tgt`, { priceIdr: '6000000' });
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: sourcePaket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '5000000', paidAmount: '3000000', status: 'DP_PAID',
    },
  });
  // Source paket has 1 kursi claimed pre-reschedule
  await db.paket.update({
    where: { id: sourcePaket.id },
    data: { kursiTerisi: 1 },
  });

  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await rescheduleBooking({
    req: fakeReq, actor,
    sourceBookingId: source.id,
    targetPaketId: targetPaket.id,
    targetKelas: 'QUAD',
    reason: 'jemaah minta tunda',
  });
  assert.ok(r.newBooking, 'new booking returned');
  assert.ok(r.source, 'source returned');

  // Verify source state
  const fresh = await db.booking.findUnique({
    where: { id: source.id },
    select: { status: true, rescheduledToBookingId: true, rescheduledAt: true, rescheduledByEmail: true },
  });
  assert.equal(fresh.status, 'RESCHEDULED');
  assert.equal(fresh.rescheduledToBookingId, r.newBooking.id);
  assert.ok(fresh.rescheduledAt);
  assert.equal(fresh.rescheduledByEmail, admin.email);

  // Verify new booking
  const fresh2 = await db.booking.findUnique({
    where: { id: r.newBooking.id },
    select: { paketId: true, jemaahId: true, kelas: true, paxCount: true, totalAmount: true, paidAmount: true, status: true },
  });
  assert.equal(fresh2.paketId, targetPaket.id);
  assert.equal(fresh2.jemaahId, jem.jemaah.id);
  assert.equal(fresh2.kelas, 'QUAD');
  assert.equal(fresh2.paxCount, 1);
  assert.equal(Number(fresh2.totalAmount), 6000000);
  assert.equal(Number(fresh2.paidAmount), 3000000); // carried over
  assert.equal(fresh2.status, 'DP_PAID'); // 3M < 6M but >0 → DP_PAID

  // Kursi pools updated
  const sourceP = await db.paket.findUnique({ where: { id: sourcePaket.id }, select: { kursiTerisi: true } });
  const targetP = await db.paket.findUnique({ where: { id: targetPaket.id }, select: { kursiTerisi: true } });
  assert.equal(sourceP.kursiTerisi, 0); // freed
  assert.equal(targetP.kursiTerisi, 1); // claimed
});

test('S337 — carried paid >= new total → status LUNAS', async (t) => {
  const tag = makeTag('s337b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`, { priceIdr: '5000000' });
  const tgt = await freshPaket(t, `${tag}-tgt`, { priceIdr: '4000000' });
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await rescheduleBooking({
    req: fakeReq, actor,
    sourceBookingId: source.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
  });
  const fresh = await db.booking.findUnique({
    where: { id: r.newBooking.id },
    select: { status: true, paidAmount: true, totalAmount: true },
  });
  assert.equal(fresh.status, 'LUNAS');
  // paid > total but we don't refund — it stays carried. New total stays at price * pax.
  assert.equal(Number(fresh.paidAmount), 5000000);
  assert.equal(Number(fresh.totalAmount), 4000000);
});

test('S337 — refuses when source already terminal', async (t) => {
  const tag = makeTag('s337c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0',
      status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    rescheduleBooking({ req: fakeReq, actor, sourceBookingId: source.id, targetPaketId: tgt.id, targetKelas: 'QUAD' }),
    /sudah CANCELLED/,
  );
});

test('S337 — refuses when target has no seats', async (t) => {
  const tag = makeTag('s337d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`, { kursiTotal: 1 });
  await db.paket.update({ where: { id: tgt.id }, data: { kursiTerisi: 1 } }); // full
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    rescheduleBooking({ req: fakeReq, actor, sourceBookingId: source.id, targetPaketId: tgt.id, targetKelas: 'QUAD' }),
    /Kursi tidak cukup/,
  );
});

test('S337 — refuses when target paket = source paket', async (t) => {
  const tag = makeTag('s337e');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await freshPaket(t, `${tag}-only`);
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    rescheduleBooking({ req: fakeReq, actor, sourceBookingId: source.id, targetPaketId: paket.id, targetKelas: 'QUAD' }),
    /sama dengan paket sumber/,
  );
});

test('S339 — notifyBookingRescheduled enqueues EMAIL + WA to jemaah', async (t) => {
  const tag = makeTag('s339a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`, { priceIdr: '6000000' });
  const source = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '5000000', paidAmount: '2000000', status: 'DP_PAID',
    },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await rescheduleBooking({
    req: fakeReq, actor,
    sourceBookingId: source.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
  });
  const notifs = await db.notification.findMany({
    where: { type: 'BOOKING_RESCHEDULED', relatedEntityId: r.newBooking.id },
    select: { channel: true, subject: true, body: true },
  });
  assert.ok(notifs.length >= 1, 'at least one BOOKING_RESCHEDULED notif fired');
  const jemaahNotif = notifs.find((n) => n.body.includes('dipindah'));
  assert.ok(jemaahNotif, 'jemaah notif body mentions dipindah');
});
