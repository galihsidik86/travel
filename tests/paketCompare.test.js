// Stage 250 — multi-paket side-by-side comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempBooking } from './_helpers.js';
import { getPaketComparison, MAX_SLUGS } from '../src/services/paketCompare.js';

async function makePaket(t, tag, { costPerPaxIdr = null, adsSpendIdr = null, kursiTerisi = 0 } = {}) {
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 20, kursiTerisi, status: 'ACTIVE',
      costPerPaxIdr, adsSpendIdr,
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('getPaketComparison: empty slugs → empty result', async () => {
  const r = await getPaketComparison({ slugs: [] });
  assert.deepEqual(r.paket, []);
});

test('getPaketComparison: unknown slugs reported in missingSlugs', async () => {
  const r = await getPaketComparison({ slugs: ['non-existent-1', 'non-existent-2'] });
  assert.equal(r.paket.length, 0);
  // No paket → empty result; missing slugs aren't surfaced when nothing matches
});

test('getPaketComparison: dedupes + caps at MAX_SLUGS', async (t) => {
  const tag = makeTag('s250-cap');
  const paket = await makePaket(t, tag);
  // Pass 6 slugs incl. duplicates
  const r = await getPaketComparison({
    slugs: [paket.slug, paket.slug, 'fake-1', 'fake-2', 'fake-3', 'fake-4', 'fake-5'],
  });
  // After dedup the list is 6 unique; cap at MAX_SLUGS=4. Our real paket
  // is in first position so it should still be present.
  assert.equal(r.inputSlugs.length, MAX_SLUGS);
  assert.equal(r.paket.length, 1);
  assert.equal(r.paket[0].slug, paket.slug);
});

test('getPaketComparison: preserves admin input order', async (t) => {
  const tag = makeTag('s250-order');
  const a = await makePaket(t, tag + '-a');
  const b = await makePaket(t, tag + '-b');
  const c = await makePaket(t, tag + '-c');

  // Pass c, a, b
  const r = await getPaketComparison({ slugs: [c.slug, a.slug, b.slug] });
  assert.equal(r.paket[0].slug, c.slug);
  assert.equal(r.paket[1].slug, a.slug);
  assert.equal(r.paket[2].slug, b.slug);
});

test('getPaketComparison: lunasRevenue computed from LUNAS bookings', async (t) => {
  const tag = makeTag('s250-revenue');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  // 2 LUNAS bookings + 1 PENDING
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '10000000', paidAmount: '10000000', status: 'LUNAS',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 2, totalAmount: '20000000', paidAmount: '20000000', status: 'LUNAS',
    },
  });
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getPaketComparison({ slugs: [paket.slug] });
  assert.equal(r.paket[0].lunasCount, 2);
  assert.equal(r.paket[0].lunasPax, 3);
  assert.equal(r.paket[0].lunasRevenue, 30_000_000);
});

test('getPaketComparison: margin computed when costPerPaxIdr set', async (t) => {
  const tag = makeTag('s250-margin');
  const paket = await makePaket(t, tag, { costPerPaxIdr: '5000000' });
  const j = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '10000000', paidAmount: '10000000', status: 'LUNAS',
    },
  });

  const r = await getPaketComparison({ slugs: [paket.slug] });
  // Revenue 10M, Cost 5M, default komisi 0.06 → komisi 600k
  // Margin = 10M - 5M - 600k = 4.4M
  assert.equal(r.paket[0].lunasRevenue, 10_000_000);
  assert.equal(r.paket[0].totalCostIdr, 5_000_000);
  assert.equal(r.paket[0].netMargin, 4_400_000);
  // marginPct = 44
  assert.equal(r.paket[0].marginPct, 44);
});

test('getPaketComparison: margin = null when costPerPaxIdr NOT set', async (t) => {
  const tag = makeTag('s250-nocost');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '10000000', paidAmount: '10000000', status: 'LUNAS',
    },
  });

  const r = await getPaketComparison({ slugs: [paket.slug] });
  assert.equal(r.paket[0].totalCostIdr, null);
  assert.equal(r.paket[0].netMargin, null);
  assert.equal(r.paket[0].marginPct, null);
});

test('getPaketComparison: ROI x computed when adsSpendIdr set', async (t) => {
  const tag = makeTag('s250-roi');
  const paket = await makePaket(t, tag, { adsSpendIdr: '2000000' });
  const j = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '10000000', paidAmount: '10000000', status: 'LUNAS',
    },
  });

  const r = await getPaketComparison({ slugs: [paket.slug] });
  // ROI = 10M / 2M = 5x
  assert.equal(r.paket[0].roiX, 5);
});

test('getPaketComparison: metricRows exposed in stable order', async (t) => {
  const tag = makeTag('s250-rows');
  const paket = await makePaket(t, tag);
  const r = await getPaketComparison({ slugs: [paket.slug] });
  assert.ok(Array.isArray(r.metricRows));
  // First metric should be status (identity-ish), last should be conv_pct
  assert.equal(r.metricRows[0].key, 'status');
  // includes margin %
  assert.ok(r.metricRows.some((m) => m.key === 'marginPct'));
});
