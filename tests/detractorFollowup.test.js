// Stage 316-318 — detractor follow-up lifecycle + queue + escalation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  ackDetractorFeedback, resolveDetractorFeedback, markDetractorUnreachable,
  listDetractorFeedback, DETRACTOR_THRESHOLD, submitTripFeedback,
} from '../src/services/tripFeedback.js';
import {
  getStaleDetractors, escalateStaleDetractors,
} from '../src/services/detractorEscalate.js';

async function lunasPastPaket(t, tag, jem) {
  const ret = new Date(Date.now() - 30 * 86_400_000);
  const dep = new Date(ret.getTime() - 10 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    const bookings = await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (bookings.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: { in: ['Booking', 'TripFeedback'] }, relatedEntityId: { in: bookings.map((b) => b.id) } },
      });
    }
    const fbIds = await db.tripFeedback.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (fbIds.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: 'TripFeedback', relatedEntityId: { in: fbIds.map((r) => r.id) } },
      });
    }
    await db.tripFeedback.deleteMany({ where: { paketId: paket.id } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-${Math.random().toString(36).slice(2, 6)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  return { paket, booking: b };
}

test('S316 — new TripFeedback defaults to followUpStatus=NEW', async (t) => {
  const tag = makeTag('s316a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: owner.email } });
  });
  const row = await submitTripFeedback({
    userId: jem.id, bookingId: booking.id, score: 3, comment: 'kurang',
  });
  const fresh = await db.tripFeedback.findUnique({
    where: { id: row.id },
    select: { followUpStatus: true, escalatedAt: true },
  });
  assert.equal(fresh.followUpStatus, 'NEW');
  assert.equal(fresh.escalatedAt, null);
});

test('S316 — ack transitions NEW → ACKED + stamps actor', async (t) => {
  const tag = makeTag('s316b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  const fb = await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 3 });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  const after = await ackDetractorFeedback({ req: fakeReq, actor, feedbackId: fb.id, note: 'will call' });
  assert.equal(after.followUpStatus, 'ACKED');
  assert.equal(after.followedUpByEmail, admin.email);
  assert.equal(after.followUpNote, 'will call');
});

test('S316 — resolve requires note (min 3 chars)', async (t) => {
  const tag = makeTag('s316c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  const fb = await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 4 });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    resolveDetractorFeedback({ req: fakeReq, actor, feedbackId: fb.id, note: 'ab' }),
    /minimal 3/,
  );
  const after = await resolveDetractorFeedback({
    req: fakeReq, actor, feedbackId: fb.id, note: 'sudah hubungi + tawarkan kompensasi',
  });
  assert.equal(after.followUpStatus, 'RESOLVED');
});

test('S316 — refuses transition on non-detractor (score ≥7)', async (t) => {
  const tag = makeTag('s316d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  const fb = await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 9 });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await assert.rejects(
    ackDetractorFeedback({ req: fakeReq, actor, feedbackId: fb.id }),
    /detractor/,
  );
});

test('S316 — refuses backward transition (RESOLVED cannot go to ACKED)', async (t) => {
  const tag = makeTag('s316e');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  const fb = await submitTripFeedback({ userId: jem.id, bookingId: booking.id, score: 2 });
  const actor = { id: admin.id, email: admin.email, role: admin.role };
  await resolveDetractorFeedback({ req: fakeReq, actor, feedbackId: fb.id, note: 'done' });
  await assert.rejects(
    ackDetractorFeedback({ req: fakeReq, actor, feedbackId: fb.id }),
    /transisi/,
  );
});

test('S317 — listDetractorFeedback filters by status + computes counts', async (t) => {
  const tag = makeTag('s317a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const { paket } = await lunasPastPaket(t, `${tag}-p`, jem);
  // Create 3 detractor rows on different bookings
  const fbIds = [];
  for (let i = 0; i < 3; i++) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${i}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
      },
    });
    const fb = await db.tripFeedback.create({
      data: { bookingId: b.id, paketId: paket.id, score: 3 + i },
    });
    fbIds.push(fb.id);
  }
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });

  // Default 'OPEN' returns NEW + ACKED
  const all = await listDetractorFeedback({});
  const mine = all.rows.filter((r) => fbIds.includes(r.id));
  assert.equal(mine.length, 3);
  assert.equal(mine.every((r) => r.followUpStatus === 'NEW'), true);
  // counts.NEW should at minimum include our 3
  assert.ok(all.counts.NEW >= 3);
});

test('S318 — getStaleDetractors picks up NEW rows older than threshold', async (t) => {
  const tag = makeTag('s318a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const { paket } = await lunasPastPaket(t, `${tag}-p`, jem);
  // Inject an old NEW detractor (submittedAt = 60h ago)
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-old`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const fb = await db.tripFeedback.create({
    data: {
      bookingId: b.id, paketId: paket.id, score: 2,
      submittedAt: new Date(Date.now() - 60 * 3_600_000),
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: owner.email } });
  });

  const stale = await getStaleDetractors({ olderThanHours: 48 });
  const found = stale.find((r) => r.id === fb.id);
  assert.ok(found, 'stale detractor surfaces');
});

test('S318 — escalateStaleDetractors fan-outs to OWNER + stamps escalatedAt', async (t) => {
  const tag = makeTag('s318b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const { paket } = await lunasPastPaket(t, `${tag}-p`, jem);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-old`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const fb = await db.tripFeedback.create({
    data: {
      bookingId: b.id, paketId: paket.id, score: 1,
      submittedAt: new Date(Date.now() - 72 * 3_600_000),
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: owner.email } });
  });

  const result = await escalateStaleDetractors({ olderThanHours: 48 });
  assert.ok(result.candidateCount >= 1);
  const stamped = await db.tripFeedback.findUnique({
    where: { id: fb.id }, select: { escalatedAt: true },
  });
  assert.ok(stamped.escalatedAt, 'escalatedAt stamped');
  const notif = await db.notification.findFirst({
    where: { type: 'NPS_DETRACTOR_ESCALATED', recipientEmail: owner.email },
    orderBy: { createdAt: 'desc' },
    select: { subject: true },
  });
  assert.ok(notif, 'escalation email enqueued');
  assert.match(notif.subject, /Detractor belum di-handle/);
});

test('S318 — re-running on already-escalated row is a no-op', async (t) => {
  const tag = makeTag('s318c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const { paket } = await lunasPastPaket(t, `${tag}-p`, jem);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-old`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  await db.tripFeedback.create({
    data: {
      bookingId: b.id, paketId: paket.id, score: 1,
      submittedAt: new Date(Date.now() - 72 * 3_600_000),
      escalatedAt: new Date(Date.now() - 5 * 3_600_000), // already escalated
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: owner.email } });
  });
  const stale = await getStaleDetractors({ olderThanHours: 48 });
  const found = stale.find((r) => r.booking?.id === b.id);
  assert.equal(found, undefined, 'already-escalated excluded from candidates');
});

test('S316 — DETRACTOR_THRESHOLD exported as 6', () => {
  assert.equal(DETRACTOR_THRESHOLD, 6);
});
