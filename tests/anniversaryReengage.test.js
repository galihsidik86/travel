// Stage 308 — one-year anniversary nudge tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import {
  getAnniversaryCandidates, sendAnniversaryReengage,
} from '../src/services/anniversaryReengage.js';

async function paketReturnedYearAgo(t, tag, daysBack = 365) {
  // Override default tempPaket (future-departure) by creating a paket
  // whose return was ~daysBack days ago. Cleanup mirrors tempPaket.
  const ret = new Date(Date.now() - daysBack * 86_400_000);
  const dep = new Date(ret.getTime() - 10 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.paymentIntent.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S308 — picks up LUNAS booking on paket whose returnDate was ~365d ago', async (t) => {
  const tag = makeTag('s308a');
  const paket = await paketReturnedYearAgo(t, tag);
  const jem = await tempJemaah(t, `${tag}-jem`);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { notifEngagement: true },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });

  const result = await getAnniversaryCandidates({ now: new Date() });
  const found = result.find((row) => row.id === b.id);
  assert.ok(found, 'LUNAS booking surfaces in anniversary candidates');
});

test('S308 — opted-out jemaah (notifEngagement=false) excluded', async (t) => {
  const tag = makeTag('s308b');
  const paket = await paketReturnedYearAgo(t, tag);
  const jem = await tempJemaah(t, `${tag}-jem`);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { notifEngagement: false },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });

  const result = await getAnniversaryCandidates({ now: new Date() });
  const found = result.find((row) => row.id === b.id);
  assert.equal(found, undefined, 'opted-out jemaah excluded');
});

test('S308 — terminal cooldown: prior ANNIVERSARY notif excludes booking', async (t) => {
  const tag = makeTag('s308c');
  const paket = await paketReturnedYearAgo(t, tag);
  const jem = await tempJemaah(t, `${tag}-jem`);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { notifEngagement: true },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  await db.notification.create({
    data: {
      type: 'ANNIVERSARY_REENGAGE', channel: 'EMAIL',
      recipientEmail: jem.jemaah.email || 'test@example.test',
      subject: 'past anniv', body: 'past',
      status: 'SENT', sentAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: b.id } });
  });

  const result = await getAnniversaryCandidates({ now: new Date() });
  const found = result.find((row) => row.id === b.id);
  assert.equal(found, undefined, 'cooldown excludes prior-nudged booking');
});

test('S308 — non-LUNAS bookings ignored even when paket is at the 1y mark', async (t) => {
  const tag = makeTag('s308d');
  const paket = await paketReturnedYearAgo(t, tag);
  const jem = await tempJemaah(t, `${tag}-jem`);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { notifEngagement: true },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '500000',
      status: 'DP_PAID',
    },
  });

  const result = await getAnniversaryCandidates({ now: new Date() });
  const found = result.find((row) => row.id === b.id);
  assert.equal(found, undefined, 'non-LUNAS booking excluded');
});

test('S308 — sendAnniversaryReengage enqueues + skips when no contact', async (t) => {
  const tag = makeTag('s308e');
  const paket = await paketReturnedYearAgo(t, tag);
  const jem = await tempJemaah(t, `${tag}-jem`);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { notifEngagement: true },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: b.id } });
  });

  const result = await sendAnniversaryReengage({ now: new Date() });
  assert.ok(result.candidateCount >= 1);
  assert.ok(result.enqueued + result.skipped >= 1);
  const notif = await db.notification.findFirst({
    where: { type: 'ANNIVERSARY_REENGAGE', relatedEntityId: b.id },
    orderBy: { createdAt: 'desc' },
    select: { subject: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /Setahun lalu/);
});
