// Stage 293 — post-departure re-engagement nudge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  getReengageCandidates,
  sendPostDepartureReengage,
} from '../src/services/postDepartureReengage.js';

async function setPaketWindow(paket, daysAgo) {
  const ret = new Date(); ret.setDate(ret.getDate() - daysAgo);
  const dep = new Date(ret); dep.setDate(dep.getDate() - 14); // ~2-week trip
  await db.paket.update({
    where: { id: paket.id },
    data: { departureDate: dep, returnDate: ret },
  });
}

test('getReengageCandidates: surfaces LUNAS bookings whose paket returned ~30d ago', async (t) => {
  const paket = await tempPaket(t, 'pdr-window');
  const jemaah = await tempJemaah(t, 'pdr-window');
  await setPaketWindow(paket, 30); // returned 30 days ago
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  const cands = await getReengageCandidates();
  const found = cands.find((c) => c.id === b.id);
  assert.ok(found, '30d-back LUNAS surfaces');
  assert.equal(found.paket.slug, paket.slug);
});

test('getReengageCandidates: excludes non-LUNAS', async (t) => {
  const paket = await tempPaket(t, 'pdr-notlunas');
  const jemaah = await tempJemaah(t, 'pdr-notlunas');
  await setPaketWindow(paket, 30);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // Leave as PENDING — not LUNAS
  const cands = await getReengageCandidates();
  const found = cands.find((c) => c.id === b.id);
  assert.equal(found, undefined);
});

test('getReengageCandidates: excludes paket OUTSIDE the 25-45d window', async (t) => {
  const tooEarly = await tempPaket(t, 'pdr-toosoon');
  const tooLate = await tempPaket(t, 'pdr-toolate');
  await setPaketWindow(tooEarly, 10);  // only 10d back — too early
  await setPaketWindow(tooLate, 90);  // 90d back — too late
  const j1 = await tempJemaah(t, 'pdr-toosoon');
  const j2 = await tempJemaah(t, 'pdr-toolate');
  const b1 = await tempBooking({ paket: tooEarly, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket: tooLate, jemaahProfileId: j2.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  await db.booking.update({ where: { id: b2.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  const cands = await getReengageCandidates();
  const ids = cands.map((c) => c.id);
  assert.ok(!ids.includes(b1.id), 'too-early excluded');
  assert.ok(!ids.includes(b2.id), 'too-late excluded');
});

test('getReengageCandidates: excludes bookings with prior reengage notif', async (t) => {
  const paket = await tempPaket(t, 'pdr-prior');
  const jemaah = await tempJemaah(t, 'pdr-prior');
  await setPaketWindow(paket, 30);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  // Pre-create a prior reengage notif for this booking
  await db.notification.create({
    data: {
      type: 'POST_DEPARTURE_REENGAGE', channel: 'EMAIL', status: 'SENT',
      recipientEmail: 'prior@test',
      subject: 'prior', body: 'prior',
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });
  const cands = await getReengageCandidates();
  const found = cands.find((c) => c.id === b.id);
  assert.equal(found, undefined, 'prior-notif excluded');
});

test('sendPostDepartureReengage: enqueues EMAIL to LUNAS jemaah with email', async (t) => {
  const paket = await tempPaket(t, 'pdr-send');
  const jemaah = await tempJemaah(t, 'pdr-send');
  await setPaketWindow(paket, 30);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  const r = await sendPostDepartureReengage({});
  assert.ok(r.candidateCount > 0);
  const notif = await db.notification.findFirst({
    where: { type: 'POST_DEPARTURE_REENGAGE', relatedEntityId: b.id },
  });
  assert.ok(notif, 'notif enqueued');
  assert.ok(notif.body.includes(paket.title), 'body mentions paket');
});

test('sendPostDepartureReengage: terminal cooldown (re-run does nothing for same booking)', async (t) => {
  const paket = await tempPaket(t, 'pdr-cooldown');
  const jemaah = await tempJemaah(t, 'pdr-cooldown');
  await setPaketWindow(paket, 30);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  await sendPostDepartureReengage({});
  const after1 = await db.notification.count({
    where: { type: 'POST_DEPARTURE_REENGAGE', relatedEntityId: b.id },
  });
  await sendPostDepartureReengage({});
  const after2 = await db.notification.count({
    where: { type: 'POST_DEPARTURE_REENGAGE', relatedEntityId: b.id },
  });
  assert.equal(after1, after2, 'cooldown blocked repeat');
});
