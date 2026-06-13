// Stage 276 — daily admin digest of SUBMITTED docs > 48h.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking, tempUser, makeTag } from './_helpers.js';
import {
  getStaleSubmittedDocs,
  sendDocVerifySlaDigest,
} from '../src/services/docVerifySlaDigest.js';

test('getStaleSubmittedDocs: returns docs older than budget', async (t) => {
  const paket = await tempPaket(t, 'dsd-old');
  const jemaah = await tempJemaah(t, 'dsd-old');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const old = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', submittedAt: threeDaysAgo },
  });
  const fresh = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'VISA_UMROH', status: 'SUBMITTED', submittedAt: new Date() },
  });
  const rows = await getStaleSubmittedDocs({ budgetHours: 48 });
  const ids = rows.map((r) => r.docId);
  assert.ok(ids.includes(old.id), '3d-old surfaces');
  assert.ok(!ids.includes(fresh.id), 'fresh excluded');
});

test('getStaleSubmittedDocs: excludes non-SUBMITTED', async (t) => {
  const paket = await tempPaket(t, 'dsd-vrf');
  const jemaah = await tempJemaah(t, 'dsd-vrf');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
  const ver = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'VERIFIED', submittedAt: fiveDaysAgo },
  });
  const rows = await getStaleSubmittedDocs({ budgetHours: 48 });
  const ids = rows.map((r) => r.docId);
  assert.ok(!ids.includes(ver.id));
});

test('getStaleSubmittedDocs: sorted by submittedAt asc (oldest first)', async (t) => {
  const paket = await tempPaket(t, 'dsd-srt');
  const jemaah = await tempJemaah(t, 'dsd-srt');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const d10 = new Date(Date.now() - 10 * 86400000);
  const d5 = new Date(Date.now() - 5 * 86400000);
  const a = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', submittedAt: d5 },
  });
  const b = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'VISA_UMROH', status: 'SUBMITTED', submittedAt: d10 },
  });
  const rows = await getStaleSubmittedDocs({ budgetHours: 48 });
  const idxA = rows.findIndex((r) => r.docId === a.id);
  const idxB = rows.findIndex((r) => r.docId === b.id);
  // b is 10 days old → comes before a (5 days)
  assert.ok(idxB < idxA);
});

test('getStaleSubmittedDocs: ageHours computed correctly', async (t) => {
  const paket = await tempPaket(t, 'dsd-age');
  const jemaah = await tempJemaah(t, 'dsd-age');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000);
  const d = await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', submittedAt: fourDaysAgo },
  });
  const rows = await getStaleSubmittedDocs({ budgetHours: 48 });
  const row = rows.find((r) => r.docId === d.id);
  assert.ok(row);
  // 4 days × 24 = 96h
  assert.ok(row.ageHours >= 95 && row.ageHours <= 97);
});

test('sendDocVerifySlaDigest: silent when no stale docs', async () => {
  const r = await sendDocVerifySlaDigest({
    now: new Date('2020-01-01T00:00:00'), // far past — nothing predates this in any reasonable test env
  });
  assert.equal(typeof r.rowCount, 'number');
  assert.equal(typeof r.enqueued, 'number');
});

test('sendDocVerifySlaDigest: enqueues EMAIL when stale docs exist', async (t) => {
  const paket = await tempPaket(t, 'dsd-snd');
  const jemaah = await tempJemaah(t, 'dsd-snd');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
  await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', submittedAt: fiveDaysAgo },
  });
  const owner = await tempUser(t, makeTag('dsd-snd-ow'), { role: 'OWNER' });
  const before = await db.notification.count({
    where: { type: 'DOC_VERIFY_SLA_ADMIN', recipientEmail: owner.email },
  });
  const r = await sendDocVerifySlaDigest({});
  assert.ok(r.rowCount > 0);
  const after = await db.notification.count({
    where: { type: 'DOC_VERIFY_SLA_ADMIN', recipientEmail: owner.email },
  });
  assert.ok(after > before, 'notif enqueued to admin');
});

test('sendDocVerifySlaDigest: 24h cooldown skips recent recipients', async (t) => {
  const paket = await tempPaket(t, 'dsd-cd');
  const jemaah = await tempJemaah(t, 'dsd-cd');
  await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  await db.jemaahDocument.create({
    data: { jemaahId: jemaah.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', submittedAt: sevenDaysAgo },
  });
  const owner = await tempUser(t, makeTag('dsd-cd-ow'), { role: 'OWNER' });
  await sendDocVerifySlaDigest({});
  const after1 = await db.notification.count({
    where: { type: 'DOC_VERIFY_SLA_ADMIN', recipientEmail: owner.email },
  });
  await sendDocVerifySlaDigest({});
  const after2 = await db.notification.count({
    where: { type: 'DOC_VERIFY_SLA_ADMIN', recipientEmail: owner.email },
  });
  assert.equal(after1, after2, 'cooldown blocked second enqueue');
});
