// Stage 346-348 — bulk reschedule service + agent aggregation notif.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { bulkRescheduleBookings } from '../src/services/bookingAdmin.js';

async function freshPaket(t, tag, { priceIdr = '5000000', kursiTotal = 50 } = {}) {
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
    await db.notification.deleteMany({ where: { relatedEntity: 'Paket', relatedEntityId: paket.id } });
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-ag@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: {
        create: {
          slug: `${tag}-slug`, displayName: `Agen ${tag}`,
          whatsapp: '+62811', tier: 'BRONZE',
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('S346 — empty source paket returns zero counts', async (t) => {
  const tag = makeTag('s346a');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await bulkRescheduleBookings({
    req: fakeReq, actor,
    sourcePaketId: src.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
  });
  assert.equal(r.counts.total, 0);
  assert.equal(r.counts.moved, 0);
});

test('S346 — moves N bookings, updates kursi pools, source goes RESCHEDULED', async (t) => {
  const tag = makeTag('s346b');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  // Create 3 bookings on source
  for (let i = 0; i < 3; i++) {
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${i}`,
        paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      },
    });
  }
  // Manually claim 3 kursi on src
  await db.paket.update({ where: { id: src.id }, data: { kursiTerisi: 3 } });

  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await bulkRescheduleBookings({
    req: fakeReq, actor,
    sourcePaketId: src.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
    reason: 'vendor failed', reasonCode: 'OPERATOR_INITIATED',
  });
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.moved, 3);
  assert.equal(r.counts.failed, 0);

  // All 3 source bookings should be RESCHEDULED
  const sources = await db.booking.findMany({
    where: { paketId: src.id, bookingNo: { startsWith: `RP-${tag}-` } },
    select: { status: true, rescheduledToBookingId: true, rescheduleReasonCode: true },
  });
  assert.equal(sources.length, 3);
  for (const s of sources) {
    assert.equal(s.status, 'RESCHEDULED');
    assert.ok(s.rescheduledToBookingId);
    assert.equal(s.rescheduleReasonCode, 'OPERATOR_INITIATED');
  }

  // Kursi pools updated
  const srcP = await db.paket.findUnique({ where: { id: src.id }, select: { kursiTerisi: true } });
  const tgtP = await db.paket.findUnique({ where: { id: tgt.id }, select: { kursiTerisi: true } });
  assert.equal(srcP.kursiTerisi, 0);
  assert.equal(tgtP.kursiTerisi, 3);
});

test('S346 — refuses with TARGET_INSUFFICIENT when target lacks capacity', async (t) => {
  const tag = makeTag('s346c');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`, { kursiTotal: 2 });
  // Source has 3 bookings, target has only 2 seats
  for (let i = 0; i < 3; i++) {
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${i}`,
        paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING',
      },
    });
  }
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    bulkRescheduleBookings({
      req: fakeReq, actor,
      sourcePaketId: src.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
    }),
    /tidak cukup kursi/,
  );
});

test('S346 — refuses on same source/target paket', async (t) => {
  const tag = makeTag('s346d');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await freshPaket(t, `${tag}-p`);
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    bulkRescheduleBookings({
      req: fakeReq, actor,
      sourcePaketId: paket.id, targetPaketId: paket.id, targetKelas: 'QUAD',
    }),
    /sama/,
  );
});

test('S348 — agent aggregation: ONE email per agent listing all their moved bookings', async (t) => {
  const tag = makeTag('s348a');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const ag1 = await tempAgent(t, `${tag}-a1`);
  const ag2 = await tempAgent(t, `${tag}-a2`);
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  // 2 bookings under ag1, 1 under ag2, 1 walk-in
  await db.booking.create({
    data: { bookingNo: `RP-${tag}-1`, paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      agentId: ag1.agent.id, kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING' },
  });
  await db.booking.create({
    data: { bookingNo: `RP-${tag}-2`, paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      agentId: ag1.agent.id, kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING' },
  });
  await db.booking.create({
    data: { bookingNo: `RP-${tag}-3`, paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      agentId: ag2.agent.id, kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING' },
  });
  await db.booking.create({
    data: { bookingNo: `RP-${tag}-4`, paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      agentId: null, kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING' },
  });

  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const r = await bulkRescheduleBookings({
    req: fakeReq, actor,
    sourcePaketId: src.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
    reasonCode: 'OPERATOR_INITIATED',
  });
  assert.equal(r.counts.moved, 4);

  // ag1 should have ONE aggregate notif covering 2 bookings
  const ag1Notif = await db.notification.findFirst({
    where: { type: 'BOOKING_RESCHEDULED', recipientEmail: ag1.email },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, body: true, payload: true },
  });
  assert.ok(ag1Notif, 'ag1 got aggregate notif');
  assert.match(ag1Notif.subject, /2 booking dipindah/);
  assert.equal(ag1Notif.payload.kind, 'bulk_reschedule_agent');

  // ag2 should have ONE aggregate notif covering 1 booking
  const ag2Notif = await db.notification.findFirst({
    where: { type: 'BOOKING_RESCHEDULED', recipientEmail: ag2.email },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, payload: true },
  });
  assert.ok(ag2Notif, 'ag2 got aggregate notif');
  assert.match(ag2Notif.subject, /1 booking dipindah/);

  // Walk-in booking should NOT trigger a per-booking agent notif
  // (no agent to notify). Verify only TWO agent rows exist for the
  // bulk_reschedule_agent payload across our tag.
  const agentAggs = await db.notification.findMany({
    where: {
      type: 'BOOKING_RESCHEDULED',
      relatedEntity: 'Paket',
      relatedEntityId: src.id,
    },
  });
  assert.equal(agentAggs.length, 2, 'exactly 2 agent aggregate notifs (one per affected agent)');
});

test('S348 — admin summary email fires after bulk reschedule', async (t) => {
  const tag = makeTag('s348b');
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const src = await freshPaket(t, `${tag}-src`);
  const tgt = await freshPaket(t, `${tag}-tgt`);
  await db.booking.create({
    data: { bookingNo: `RP-${tag}-1`, paketId: src.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'PENDING' },
  });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await bulkRescheduleBookings({
    req: fakeReq, actor,
    sourcePaketId: src.id, targetPaketId: tgt.id, targetKelas: 'QUAD',
  });
  // Admin gets a GENERIC summary email with bulk_reschedule_admin payload
  const adminNotif = await db.notification.findFirst({
    where: {
      type: 'GENERIC',
      recipientEmail: admin.email,
      relatedEntity: 'Paket',
      relatedEntityId: src.id,
    },
    select: { subject: true, body: true, payload: true },
  });
  assert.ok(adminNotif, 'admin summary email fired');
  assert.match(adminNotif.subject, /Bulk reschedule/);
  assert.equal(adminNotif.payload.kind, 'bulk_reschedule_admin');
});
