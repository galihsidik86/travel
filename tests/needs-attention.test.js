// Stage 31 — needs-attention rollup. Asserts the 24h cutoff filter, the
// FAILED-terminal definition, and counts shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempMuthawwif } from './_helpers.js';
import { getNeedsAttention } from '../src/services/needsAttention.js';

const ONE_DAY_MS = 86_400_000;

test('returns the four-keyed shape on an empty environment', async () => {
  const res = await getNeedsAttention();
  for (const key of ['notifsFailed', 'cancelRequests', 'openIncidents']) {
    assert.ok(Array.isArray(res[key]));
  }
  for (const key of ['notifsFailed', 'cancelRequests', 'openIncidents', 'total']) {
    assert.ok(typeof res.counts[key] === 'number');
  }
  assert.equal(res.counts.total, res.counts.notifsFailed + res.counts.cancelRequests + res.counts.openIncidents);
});

test('cancel-requests <24h do NOT appear (cutoff respected)', async (t) => {
  const tag = makeTag('na-cancel-fresh');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: booking.id },
    data: {
      cancelRequested: true,
      cancelRequestedAt: new Date(), // fresh — should NOT appear
      cancelRequestReason: 'fresh request',
    },
  });
  const res = await getNeedsAttention();
  const found = res.cancelRequests.find((r) => r.id === booking.id);
  assert.equal(found, undefined, 'fresh cancel request must be filtered out');
});

test('cancel-requests >24h DO appear', async (t) => {
  const tag = makeTag('na-cancel-aged');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const aged = new Date(Date.now() - 2 * ONE_DAY_MS); // 48h ago
  await db.booking.update({
    where: { id: booking.id },
    data: {
      cancelRequested: true,
      cancelRequestedAt: aged,
      cancelRequestReason: 'aged request',
    },
  });
  const res = await getNeedsAttention();
  const found = res.cancelRequests.find((r) => r.id === booking.id);
  assert.ok(found, 'aged cancel request must appear');
  assert.ok(found.ageHours >= 24);
  assert.equal(found.cancelRequestReason, 'aged request');
});

test('OPEN incidents >24h appear, ACKED/RESOLVED never appear', async (t) => {
  const tag = makeTag('na-incident');
  const muth = await tempMuthawwif(t, tag);
  const aged = new Date(Date.now() - 30 * 60 * 60_000); // 30h ago
  const fresh = new Date(Date.now() - 60 * 60_000);     // 1h ago

  const i1 = await db.incident.create({
    data: {
      type: 'SOS', message: 'aged open', createdById: muth.id,
      status: 'OPEN', createdAt: aged,
    },
  });
  const i2 = await db.incident.create({
    data: {
      type: 'SOS', message: 'fresh open', createdById: muth.id,
      status: 'OPEN', createdAt: fresh,
    },
  });
  const i3 = await db.incident.create({
    data: {
      type: 'SOS', message: 'aged but acked', createdById: muth.id,
      status: 'ACKED', createdAt: aged, ackedAt: new Date(),
    },
  });
  t.after(async () => {
    await db.incident.deleteMany({ where: { id: { in: [i1.id, i2.id, i3.id] } } });
  });

  const res = await getNeedsAttention();
  assert.ok(res.openIncidents.some((i) => i.id === i1.id), 'aged OPEN must appear');
  assert.ok(!res.openIncidents.some((i) => i.id === i2.id), 'fresh OPEN must be excluded');
  assert.ok(!res.openIncidents.some((i) => i.id === i3.id), 'ACKED must never appear');
});

test('terminal-FAILED notifs appear; retrying-FAILED do not', async () => {
  // status=FAILED, nextRetryAt=null → terminal
  const terminal = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'na-term@example.test',
      subject: 'na-term', body: '—',
      attemptCount: 3, nextRetryAt: null,
      error: 'gave up', lastAttemptAt: new Date(),
    },
  });
  // status=FAILED but nextRetryAt set → still in retry loop
  const retrying = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'na-retry@example.test',
      subject: 'na-retry', body: '—',
      attemptCount: 2,
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
      error: 'try again later', lastAttemptAt: new Date(),
    },
  });

  try {
    const res = await getNeedsAttention();
    assert.ok(res.notifsFailed.some((n) => n.id === terminal.id), 'terminal FAILED must appear');
    assert.ok(!res.notifsFailed.some((n) => n.id === retrying.id), 'still-retrying FAILED must be excluded');
  } finally {
    await db.notification.deleteMany({ where: { id: { in: [terminal.id, retrying.id] } } });
  }
});
