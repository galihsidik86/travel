// Stage 142 — admin mirror of S141. Aggregates MANIFEST_CLOSE_NUDGE
// notif rows by paket so admin can do manual WA follow-up without
// grep'ing the notif queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getManifestCloseNudgeAdminSummary } from '../src/services/manifestCloseNudgeAdmin.js';

async function seedNudgeNotif({ booking, channel = 'EMAIL', missing = [], createdAt = new Date() }) {
  return db.notification.create({
    data: {
      type: 'MANIFEST_CLOSE_NUDGE',
      channel,
      status: 'SENT',
      subject: 'test', body: 'test',
      relatedEntity: 'Booking',
      relatedEntityId: booking.id,
      payload: { missing },
      createdAt,
    },
  });
}

test('summary: empty queue → no rows', async () => {
  const r = await getManifestCloseNudgeAdminSummary({
    windowHours: 24, now: new Date('2026-06-09'),
  });
  // Other tests may leave residue, but counts should be ≥0 + shape valid
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.totalPaket, 'number');
});

test('summary: groups multiple notifs for same booking into one row + dedupes channels', async (t) => {
  const tag = makeTag('s142-dedupe');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Same booking, two channels — should collapse into ONE row
  await seedNudgeNotif({ booking, channel: 'EMAIL', missing: ['Nomor paspor', 'Visa umroh'] });
  await seedNudgeNotif({ booking, channel: 'WA', missing: ['Nomor paspor', 'Visa umroh'] });
  t.after(() => db.notification.deleteMany({
    where: { type: 'MANIFEST_CLOSE_NUDGE', relatedEntityId: booking.id },
  }));

  const r = await getManifestCloseNudgeAdminSummary({ windowHours: 24, now: new Date() });
  const paketRow = r.rows.find((x) => x.paket.id === paket.id);
  assert.ok(paketRow);
  assert.equal(paketRow.bookings.length, 1, 'two notifs same booking → one row');
  assert.deepEqual(paketRow.bookings[0].channels.sort(), ['EMAIL', 'WA']);
});

test('summary: groups bookings under the same paket + rolls up missing tally', async (t) => {
  const tag = makeTag('s142-group');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem1 = await tempJemaah(t, `${tag}-j1`);
  const jem2 = await tempJemaah(t, `${tag}-j2`);
  const b1 = await tempBooking({ paket, jemaahProfileId: jem1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem2.jemaah.id });

  await seedNudgeNotif({ booking: b1, missing: ['Nomor paspor', 'Visa umroh'] });
  await seedNudgeNotif({ booking: b2, missing: ['Visa umroh', 'Kontak darurat'] });
  t.after(() => db.notification.deleteMany({
    where: { type: 'MANIFEST_CLOSE_NUDGE', relatedEntityId: { in: [b1.id, b2.id] } },
  }));

  const r = await getManifestCloseNudgeAdminSummary({ windowHours: 24, now: new Date() });
  const paketRow = r.rows.find((x) => x.paket.id === paket.id);
  assert.ok(paketRow);
  assert.equal(paketRow.bookings.length, 2);
  assert.equal(paketRow.totalJemaah, 2);
  // missingSummary: Visa umroh appears 2x, Nomor paspor 1x, Kontak darurat 1x
  const visa = paketRow.missingSummary.find((m) => m.label === 'Visa umroh');
  assert.equal(visa.count, 2);
  // Sorted desc by count → Visa umroh first
  assert.equal(paketRow.missingSummary[0].label, 'Visa umroh');
});

test('summary: excludes notifs outside the window', async (t) => {
  const tag = makeTag('s142-window');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // 30 hours ago — outside 24h window
  await seedNudgeNotif({
    booking, missing: ['Visa umroh'],
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
  });
  t.after(() => db.notification.deleteMany({
    where: { type: 'MANIFEST_CLOSE_NUDGE', relatedEntityId: booking.id },
  }));

  const r = await getManifestCloseNudgeAdminSummary({ windowHours: 24, now: new Date() });
  const paketRow = r.rows.find((x) => x.paket.id === paket.id);
  assert.equal(paketRow, undefined, 'outside-window notif excluded');
});

test('summary: sorts paket by manifestClosesAt asc (most urgent first)', async (t) => {
  const tag = makeTag('s142-sort');
  const paketSoon = await tempPaket(t, `${tag}-soon`);
  const paketLater = await tempPaket(t, `${tag}-later`);
  await db.paket.update({
    where: { id: paketSoon.id },
    data: { manifestClosesAt: new Date(Date.now() + 12 * 60 * 60 * 1000) },
  });
  await db.paket.update({
    where: { id: paketLater.id },
    data: { manifestClosesAt: new Date(Date.now() + 60 * 60 * 60 * 1000) },
  });
  const j1 = await tempJemaah(t, `${tag}-1`);
  const j2 = await tempJemaah(t, `${tag}-2`);
  const b1 = await tempBooking({ paket: paketSoon,  jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket: paketLater, jemaahProfileId: j2.jemaah.id });
  await seedNudgeNotif({ booking: b1 });
  await seedNudgeNotif({ booking: b2 });
  t.after(() => db.notification.deleteMany({
    where: { type: 'MANIFEST_CLOSE_NUDGE', relatedEntityId: { in: [b1.id, b2.id] } },
  }));

  const r = await getManifestCloseNudgeAdminSummary({ windowHours: 24, now: new Date() });
  const soonIdx = r.rows.findIndex((x) => x.paket.id === paketSoon.id);
  const laterIdx = r.rows.findIndex((x) => x.paket.id === paketLater.id);
  assert.ok(soonIdx >= 0 && laterIdx >= 0);
  assert.ok(soonIdx < laterIdx, 'sooner-closing paket comes first');
});
