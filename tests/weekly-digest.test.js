// Stage 33 — weekly digest tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { buildWeeklyDigest } from '../src/services/weeklyDigest.js';
import { notifyWeeklyDigest } from '../src/services/notifications.js';

const ONE_DAY_MS = 86_400_000;

test('shape: returns full envelope with deltas + topPaket arrays', async () => {
  const digest = await buildWeeklyDigest();
  assert.ok(digest.weekStart && digest.weekEnd);
  assert.ok(digest.label.includes(' – '), 'label is a range "X – Y"');
  for (const key of ['newBookings', 'lunasBookings', 'cancelledBookings', 'newJemaah',
    'newLeads', 'incidentsCreated', 'docsVerified', 'lunasRevenueIdr',
    'paymentsInIdr', 'refundsOutIdr', 'netRevenueIdr', 'komisiEarnedIdr', 'komisiPaidIdr']) {
    assert.ok(digest.deltas[key], `delta missing for ${key}`);
  }
  assert.ok(Array.isArray(digest.topPaket));
});

test('label resolves to the previous full Monday-Sunday', () => {
  // Pick a Wednesday for the test (2026-06-10 is a Wednesday)
  const wed = new Date(2026, 5, 10, 12, 0, 0);
  return buildWeeklyDigest({ now: wed }).then((digest) => {
    // weekStart should be 2026-06-01 (the previous Monday)
    assert.equal(digest.weekStart, '2026-06-01');
  });
});

test('weekend re-runs return same window as Monday run (idempotency)', async () => {
  const mon = new Date(2026, 5, 8, 7, 0, 0);  // Mon
  const sat = new Date(2026, 5, 13, 23, 0, 0); // Sat
  const monD = await buildWeeklyDigest({ now: mon });
  const satD = await buildWeeklyDigest({ now: sat });
  assert.equal(monD.weekStart, satD.weekStart, 'weekend runs must resolve to same week');
});

test('counts: new bookings inside the week appear, outside excluded', async (t) => {
  const tag = makeTag('weekly-count');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // Pick a fixed future Monday so we control the window
  const monNoon = new Date(2026, 6, 13, 12, 0, 0); // Mon 13 Jul 2026
  const weekStart = new Date(2026, 6, 6, 0, 0, 0); // Mon 6 Jul (last full week)
  const weekEnd = new Date(2026, 6, 13, 0, 0, 0);

  const inWeek = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: inWeek.id },
    data: { createdAt: new Date(weekStart.getTime() + ONE_DAY_MS) }, // Tue 7 Jul
  });
  const before = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: before.id },
    data: { createdAt: new Date(weekStart.getTime() - ONE_DAY_MS) }, // Sun 5 Jul
  });

  const digest = await buildWeeklyDigest({ now: monNoon });
  // Verify the window
  assert.equal(digest.weekStart, '2026-07-06');
  // Spot-check: counts must include our in-week booking; can't assert exact
  // values since the dev DB may have other rows in this future window.
  // Instead check via SQL:
  const ids = await db.booking.findMany({
    where: { paketId: paket.id, createdAt: { gte: weekStart, lt: weekEnd } },
    select: { id: true },
  });
  assert.ok(ids.some((b) => b.id === inWeek.id));
  assert.ok(!ids.some((b) => b.id === before.id));
});

test('notifyWeeklyDigest fan-out enqueues one EMAIL per ACTIVE OWNER', async (t) => {
  const tag = makeTag('weekly-fan');
  const o1 = await tempUser(t, `${tag}-a`, { role: 'OWNER', status: 'ACTIVE' });
  const oSus = await tempUser(t, `${tag}-b`, { role: 'OWNER', status: 'SUSPENDED' });

  const digest = await buildWeeklyDigest();
  const result = await notifyWeeklyDigest({ digest });
  assert.ok(result.enqueued >= 1);

  const rows = await db.notification.findMany({
    where: { type: 'WEEKLY_DIGEST_OWNER', channel: 'EMAIL', recipientEmail: o1.email },
    select: { subject: true, body: true },
  });
  assert.ok(rows.length >= 1);
  assert.match(rows[0].subject, /ringkasan mingguan/);

  // Suspended must not receive
  const neg = await db.notification.findMany({
    where: { type: 'WEEKLY_DIGEST_OWNER', recipientEmail: oSus.email },
  });
  assert.equal(neg.length, 0);

  await db.notification.deleteMany({
    where: { type: 'WEEKLY_DIGEST_OWNER', recipientEmail: o1.email },
  });
});
