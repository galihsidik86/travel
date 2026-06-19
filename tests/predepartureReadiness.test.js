// Stage 349-351 — pre-trip countdown + readiness + reminder cron tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  computeReadinessForBooking, resolveRequiredDocs,
} from '../src/services/preDepartureChecklist.js';
import {
  getReadinessReminderCandidates, sendReadinessReminders, COOLDOWN_DAYS,
} from '../src/services/predepartureReadinessReminder.js';

async function paketDeparting(t, tag, { daysAhead = 7, requiredDocs = null } = {}) {
  const dep = new Date(); dep.setHours(0, 0, 0, 0);
  dep.setDate(dep.getDate() + daysAhead);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 20, status: 'ACTIVE',
      requiredDocs,
      prices: { create: [{ kelas: 'QUAD', priceIdr: '5000000' }] },
    },
  });
  t.after(async () => {
    const bookings = await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (bookings.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: 'Booking', relatedEntityId: { in: bookings.map((b) => b.id) } },
      });
    }
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S350 — computeReadinessForBooking returns ready=100% when all 8 checks pass', async (t) => {
  const tag = makeTag('s350a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`);
  // Fill profile
  const farFuture = new Date(paket.departureDate.getTime() + 365 * 86_400_000);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: {
      passportNo: 'A1234567',
      passportExpiry: farFuture,
      emergencyContact: '+62811000',
    },
  });
  // VERIFY 4 default required docs
  for (const t of ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT', 'MANASIK_CERT']) {
    await db.jemaahDocument.create({
      data: { jemaahId: jem.jemaah.id, type: t, status: 'VERIFIED' },
    });
  }
  // Booking with room assigned
  const room = await db.room.create({
    data: { paketId: paket.id, roomNo: 'R-1', kelas: 'QUAD', capacity: 4, floor: 1 },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
      roomId: room.id,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { roomId: room.id } });
    await db.room.deleteMany({ where: { id: room.id } });
  });

  // Reload booking with the include shape getMyBooking uses
  const full = await db.booking.findUnique({
    where: { id: b.id },
    include: {
      jemaah: { include: { documents: true } },
      room: true,
    },
  });
  const r = computeReadinessForBooking({
    booking: full,
    departureDate: paket.departureDate,
    requiredDocs: resolveRequiredDocs(paket.requiredDocs),
  });
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'ready');
  assert.equal(r.passed, r.total);
});

test('S350 — readiness shows critical when most checks fail', async (t) => {
  const tag = makeTag('s350b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`);
  // Empty profile, no docs, no room
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  const full = await db.booking.findUnique({
    where: { id: b.id },
    include: { jemaah: { include: { documents: true } }, room: true },
  });
  const r = computeReadinessForBooking({
    booking: full,
    departureDate: paket.departureDate,
    requiredDocs: resolveRequiredDocs(paket.requiredDocs),
  });
  assert.equal(r.passed, 0);
  assert.equal(r.tier, 'critical');
});

test('S351 — empty candidates when no bookings in H-7 window', async () => {
  // Far-future "now" so no booking departure window matches.
  const r = await getReadinessReminderCandidates({ now: new Date('3000-01-01') });
  assert.deepEqual(r, []);
});

test('S351 — candidate surfaces when paket departs ~7d AND readiness < 100', async (t) => {
  const tag = makeTag('s351a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`, { daysAhead: 7 });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  // Empty profile → readiness < 100
  const cands = await getReadinessReminderCandidates({ now: new Date() });
  const mine = cands.find((c) => c.booking.bookingNo === `RP-${tag}-1`);
  assert.ok(mine, 'unprepared booking surfaces');
  assert.ok(mine.readiness.score < 100);
});

test('S351 — fully-ready booking does NOT appear in candidates', async (t) => {
  const tag = makeTag('s351b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`, { daysAhead: 7 });
  const farFuture = new Date(paket.departureDate.getTime() + 365 * 86_400_000);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: {
      passportNo: 'A1234567',
      passportExpiry: farFuture,
      emergencyContact: '+62811',
    },
  });
  for (const t of ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT', 'MANASIK_CERT']) {
    await db.jemaahDocument.create({
      data: { jemaahId: jem.jemaah.id, type: t, status: 'VERIFIED' },
    });
  }
  const room = await db.room.create({
    data: { paketId: paket.id, roomNo: 'R-1', kelas: 'QUAD', capacity: 4, floor: 1 },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
      roomId: room.id,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { roomId: room.id } });
    await db.room.deleteMany({ where: { id: room.id } });
  });
  const cands = await getReadinessReminderCandidates({ now: new Date() });
  const mine = cands.find((c) => c.booking.bookingNo === `RP-${tag}-1`);
  assert.equal(mine, undefined, 'fully-ready booking excluded');
});

test('S351 — recent prior notif (within cooldown) excludes booking', async (t) => {
  const tag = makeTag('s351c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`, { daysAhead: 7 });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  // Stamp a recent reminder
  await db.notification.create({
    data: {
      type: 'PREDEPARTURE_READINESS_REMINDER', channel: 'EMAIL',
      recipientEmail: 'x@y.test',
      subject: 'past', body: 'past',
      status: 'SENT', sentAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: b.id,
      createdAt: new Date(Date.now() - 2 * 86_400_000), // 2d ago
    },
  });
  const cands = await getReadinessReminderCandidates({ now: new Date() });
  const mine = cands.find((c) => c.booking.bookingNo === `RP-${tag}-1`);
  assert.equal(mine, undefined, 'recently-nudged booking excluded');
});

test('S351 — sendReadinessReminders enqueues notif for matching bookings', async (t) => {
  const tag = makeTag('s351d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketDeparting(t, `${tag}-p`, { daysAhead: 7 });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  const r = await sendReadinessReminders({ now: new Date() });
  assert.ok(r.candidateCount >= 1);
  const notif = await db.notification.findFirst({
    where: { type: 'PREDEPARTURE_READINESS_REMINDER', relatedEntityId: b.id },
    select: { subject: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /H-/);
});

test('S351 — COOLDOWN_DAYS exported as 5', () => {
  assert.equal(COOLDOWN_DAYS, 5);
});
