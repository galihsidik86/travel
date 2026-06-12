// Stage 247 — per-paket document expiry overview for admin manifest tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getPaketDocOverview, bandFor } from '../src/services/paketDocOverview.js';

async function makeDoc(jemaahId, type, status, expiresAt) {
  return db.jemaahDocument.create({
    data: { jemaahId, type, status, expiresAt, refNumber: 'X-123' },
  });
}

test('bandFor: classifies expired/urgent/warning/null', () => {
  const now = new Date('2027-06-01');
  // Past
  assert.equal(bandFor(new Date('2027-05-01'), now), 'EXPIRED');
  // Within 30d
  assert.equal(bandFor(new Date('2027-06-15'), now), 'URGENT');
  // Within 60d
  assert.equal(bandFor(new Date('2027-07-15'), now), 'WARNING');
  // > 60d → null (no band, no row)
  assert.equal(bandFor(new Date('2027-09-15'), now), null);
  // No expiry
  assert.equal(bandFor(null, now), null);
});

test('getPaketDocOverview: unknown paket → null', async () => {
  const r = await getPaketDocOverview({ paketSlug: 'does-not-exist' });
  assert.equal(r, null);
});

test('getPaketDocOverview: empty when no expiring docs', async (t) => {
  const tag = makeTag('s247-empty');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.rows.length, 0);
  assert.equal(r.counts.total, 0);
});

test('getPaketDocOverview: surfaces EXPIRED docs', async (t) => {
  const tag = makeTag('s247-expired');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await makeDoc(jem.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() - 10 * 86_400_000));
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: jem.jemaah.id } }); });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].band, 'EXPIRED');
  assert.equal(r.counts.expired, 1);
});

test('getPaketDocOverview: REJECTED + PENDING docs excluded', async (t) => {
  const tag = makeTag('s247-status');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Both within 30d but neither status is relevant
  await makeDoc(jem.jemaah.id, 'PASSPORT', 'REJECTED', new Date(Date.now() + 10 * 86_400_000));
  await makeDoc(jem.jemaah.id, 'VISA_UMROH', 'PENDING', new Date(Date.now() + 10 * 86_400_000));
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: jem.jemaah.id } }); });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.rows.length, 0);
});

test('getPaketDocOverview: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s247-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await makeDoc(jem.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() - 5 * 86_400_000));
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: jem.jemaah.id } }); });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.rows.length, 0);
});

test('getPaketDocOverview: sorted EXPIRED → URGENT → WARNING, within band oldest first', async (t) => {
  const tag = makeTag('s247-sort');
  const paket = await tempPaket(t, tag);
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  const j3 = await tempJemaah(t, tag + '-3');
  // j1: 50d future (WARNING)
  await makeDoc(j1.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() + 50 * 86_400_000));
  // j2: 20d future (URGENT)
  await makeDoc(j2.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() + 20 * 86_400_000));
  // j3: 5d past (EXPIRED)
  await makeDoc(j3.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() - 5 * 86_400_000));
  await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });
  t.after(async () => {
    await db.jemaahDocument.deleteMany({ where: { jemaahId: { in: [j1.jemaah.id, j2.jemaah.id, j3.jemaah.id] } } });
  });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].band, 'EXPIRED');
  assert.equal(r.rows[1].band, 'URGENT');
  assert.equal(r.rows[2].band, 'WARNING');
});

test('getPaketDocOverview: counts breakdown matches rows', async (t) => {
  const tag = makeTag('s247-counts');
  const paket = await tempPaket(t, tag);
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  // j1 has 2 expired docs, j2 has 1 urgent
  await makeDoc(j1.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() - 1 * 86_400_000));
  await makeDoc(j1.jemaah.id, 'VISA_UMROH', 'VERIFIED', new Date(Date.now() - 2 * 86_400_000));
  await makeDoc(j2.jemaah.id, 'PASSPORT', 'VERIFIED', new Date(Date.now() + 15 * 86_400_000));
  await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  t.after(async () => {
    await db.jemaahDocument.deleteMany({ where: { jemaahId: { in: [j1.jemaah.id, j2.jemaah.id] } } });
  });

  const r = await getPaketDocOverview({ paketSlug: paket.slug });
  assert.equal(r.counts.expired, 2);
  assert.equal(r.counts.urgent, 1);
  assert.equal(r.counts.warning, 0);
  assert.equal(r.counts.total, 3);
});
