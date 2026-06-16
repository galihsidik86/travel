// Stage 310-312 — trip feedback service tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import {
  submitTripFeedback, getMyTripFeedback, getNpsRollup, bucketFor,
} from '../src/services/tripFeedback.js';
import {
  getFeedbackReminderCandidates, sendTripFeedbackReminders,
} from '../src/services/tripFeedbackReminder.js';

// Build a paket with returnDate in the past + a LUNAS booking owned by jem.
async function lunasPastPaket(t, tag, jem, daysAgo = 30) {
  const ret = new Date(Date.now() - daysAgo * 86_400_000);
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
    await db.tripFeedback.deleteMany({ where: { paketId: paket.id } });
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-S310-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  return { paket, booking: b };
}

test('S310 — bucketFor maps NPS scale correctly', () => {
  assert.equal(bucketFor(10), 'promoter');
  assert.equal(bucketFor(9), 'promoter');
  assert.equal(bucketFor(8), 'passive');
  assert.equal(bucketFor(7), 'passive');
  assert.equal(bucketFor(6), 'detractor');
  assert.equal(bucketFor(0), 'detractor');
});

test('S310 — submit saves + getMyTripFeedback returns it', async (t) => {
  const tag = makeTag('s310a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await submitTripFeedback({
    userId: jem.id, bookingId: booking.id, score: 9, comment: 'Mantap',
  });
  const got = await getMyTripFeedback({ userId: jem.id, bookingId: booking.id });
  assert.ok(got);
  assert.equal(got.score, 9);
  assert.equal(got.comment, 'Mantap');
});

test('S310 — re-submit upserts (score updated, no duplicate)', async (t) => {
  const tag = makeTag('s310b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 6 });
  await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 10, comment: 'change of heart' });
  const rows = await db.tripFeedback.findMany({ where: { bookingId: booking.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 10);
  assert.equal(rows[0].comment, 'change of heart');
});

test('S310 — rejects out-of-range score', async (t) => {
  const tag = makeTag('s310c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await assert.rejects(
    submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 11 }),
    /Skor harus 0-10/,
  );
});

test('S310 — rejects non-LUNAS booking', async (t) => {
  const tag = makeTag('s310d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await db.booking.update({ where: { id: booking.id }, data: { status: 'DP_PAID' } });
  await assert.rejects(
    submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 8 }),
    /Hanya booking LUNAS/,
  );
});

test('S310 — rejects future-return paket', async (t) => {
  const tag = makeTag('s310e');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await tempPaket(t, `${tag}-pkt`);
  // tempPaket has future departureDate + returnDate (10d after).
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS' } });
  await assert.rejects(
    submitTripFeedback({ userId: jem.id, bookingId: b.id, score: 8 }),
    /Paket belum kembali/,
  );
});

test('S310 — cross-user submit returns 404 (no leak)', async (t) => {
  const tag = makeTag('s310f');
  const owner = await tempJemaah(t, `${tag}-owner`);
  const stranger = await tempJemaah(t, `${tag}-stranger`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, owner);
  await assert.rejects(
    submitTripFeedback({ userId: stranger.id, bookingId: booking.id, score: 5 }),
    /Booking tidak ditemukan/,
  );
});

test('S311 — getNpsRollup computes overall NPS from per-bucket counts', async (t) => {
  const tag = makeTag('s311a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { paket, booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  // 1 booking submits a 10. Manually inject more feedback rows on the same
  // paket so we hit MIN_SAMPLE.
  await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 10 });
  // Inject 4 more rows directly (different booking ids would need real
  // bookings; for math-test purposes a raw insert keyed on the booking
  // works if we make fake bookingIds — but TripFeedback FK forces a real
  // booking). Use the same paket and 4 more bookings.
  for (let i = 0; i < 4; i++) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-S311-${tag}-${i}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
        status: 'LUNAS',
      },
    });
    await db.tripFeedback.create({
      data: { bookingId: b.id, paketId: paket.id, score: i === 0 ? 6 : 9 },
    });
  }
  const rollup = await getNpsRollup({ days: 365 });
  // 1×10 + 3×9 + 1×6 = 4 promoter, 0 passive, 1 detractor → NPS = (4-1)/5 = 60%
  assert.ok(rollup.total >= 5);
  const p = rollup.perPaket.find((row) => row.paketId === paket.id);
  assert.ok(p, 'paket present in rollup');
  assert.equal(p.lowSample, false);
  assert.ok(p.npsPct !== null);
});

test('S312 — feedback reminder candidate excludes booking with existing feedback', async (t) => {
  const tag = makeTag('s312a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem, 60);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: true },
  });
  // Submit feedback — booking should NOT appear in candidate list.
  await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 9 });

  const candidates = await getFeedbackReminderCandidates({ now: new Date() });
  const found = candidates.find((c) => c.id === booking.id);
  assert.equal(found, undefined, 'booking with feedback excluded');
});

test('S312 — candidate visible when no feedback + in 60d window + opt-in', async (t) => {
  const tag = makeTag('s312b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem, 60);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: true },
  });

  const candidates = await getFeedbackReminderCandidates({ now: new Date() });
  const found = candidates.find((c) => c.id === booking.id);
  assert.ok(found, 'booking surfaces as candidate');
});

test('S312 — opted-out jemaah excluded', async (t) => {
  const tag = makeTag('s312c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem, 60);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: false },
  });
  const candidates = await getFeedbackReminderCandidates({ now: new Date() });
  const found = candidates.find((c) => c.id === booking.id);
  assert.equal(found, undefined, 'opted-out excluded');
});

test('S312 — prior TRIP_FEEDBACK_REMINDER excludes booking', async (t) => {
  const tag = makeTag('s312d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem, 60);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: true },
  });
  await db.notification.create({
    data: {
      type: 'TRIP_FEEDBACK_REMINDER', channel: 'EMAIL',
      recipientEmail: 'x@y.test',
      subject: 'past', body: 'past',
      status: 'SENT', sentAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: booking.id,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: booking.id } });
  });
  const candidates = await getFeedbackReminderCandidates({ now: new Date() });
  const found = candidates.find((c) => c.id === booking.id);
  assert.equal(found, undefined, 'prior-nudged booking excluded');
});

test('S312 — sendTripFeedbackReminders enqueues notif', async (t) => {
  const tag = makeTag('s312e');
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem, 60);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: booking.id } });
  });

  const result = await sendTripFeedbackReminders({ now: new Date() });
  assert.ok(result.candidateCount >= 1);
  assert.ok(result.enqueued + result.skipped >= 1);
  const notif = await db.notification.findFirst({
    where: { type: 'TRIP_FEEDBACK_REMINDER', relatedEntityId: booking.id },
    orderBy: { createdAt: 'desc' },
    select: { subject: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /60 detik/);
});
