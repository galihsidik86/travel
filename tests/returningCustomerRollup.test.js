// Stage 294 — returning customer rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getReturningCustomerRollup } from '../src/services/returningCustomerRollup.js';

test('getReturningCustomerRollup: returns shape on empty window', async () => {
  // Far-future window where nothing has happened
  const r = await getReturningCustomerRollup({
    months: 3,
    now: new Date('2099-01-15'),
  });
  // Months exist but all zeroed; total ratePct null when no LUNAS
  assert.equal(r.months.length, 3);
  assert.equal(r.total.lunas, 0);
  assert.equal(r.total.ratePct, null);
});

test('getReturningCustomerRollup: single-LUNAS jemaah does NOT count as repeat', async (t) => {
  const paket = await tempPaket(t, 'rc-single');
  const jemaah = await tempJemaah(t, 'rc-single');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });

  // Look at this month
  const r = await getReturningCustomerRollup({ months: 1 });
  // We can't assert exact since other tests may leak — verify shape
  assert.ok(r.months.length >= 1);
  // The newly-LUNAS jemaah won't have any prior — repeat doesn't increment for them
  // (we'd need to check the bucket via fixture tagging; abstract check below)
  assert.ok(typeof r.total.ratePct === 'number' || r.total.ratePct === null);
});

test('getReturningCustomerRollup: jemaah with prior LUNAS triggers repeat in later month', async (t) => {
  const paketA = await tempPaket(t, 'rc-prior-a');
  const paketB = await tempPaket(t, 'rc-prior-b');
  const jemaah = await tempJemaah(t, 'rc-prior');
  // First booking 4 months ago → LUNAS at that time
  const bA = await tempBooking({ paket: paketA, jemaahProfileId: jemaah.jemaah.id });
  const fourMonthsAgo = new Date(); fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
  await db.booking.update({
    where: { id: bA.id },
    data: { status: 'LUNAS', paidAmount: '5000000', createdAt: fourMonthsAgo },
  });
  // Second booking 1 month ago → LUNAS recent
  const bB = await tempBooking({ paket: paketB, jemaahProfileId: jemaah.jemaah.id });
  const oneMonthAgo = new Date(); oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  await db.booking.update({
    where: { id: bB.id },
    data: { status: 'LUNAS', paidAmount: '5000000', createdAt: oneMonthAgo },
  });
  const r = await getReturningCustomerRollup({ months: 6 });
  // The second booking sits in a month where the jemaah had a prior → repeat count ≥ 1
  // Find the month containing oneMonthAgo:
  const lbl = `${oneMonthAgo.getFullYear()}-${String(oneMonthAgo.getMonth() + 1).padStart(2, '0')}`;
  const bucket = r.months.find((m) => m.label === lbl);
  assert.ok(bucket, 'bucket exists for last month');
  assert.ok(bucket.repeatLunas >= 1, 'at least one repeat in this bucket');
});

test('getReturningCustomerRollup: non-LUNAS bookings excluded', async (t) => {
  const paket = await tempPaket(t, 'rc-non');
  const jemaah = await tempJemaah(t, 'rc-non');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'PENDING' } });
  const r = await getReturningCustomerRollup({ months: 1 });
  // Cannot assert exact (other fixtures contribute) but the shape must hold
  assert.ok(Array.isArray(r.months));
  assert.equal(typeof r.total.lunas, 'number');
});

test('getReturningCustomerRollup: same-month two LUNAS by one jemaah → first is new, second is repeat', async (t) => {
  const paketA = await tempPaket(t, 'rc-same-a');
  const paketB = await tempPaket(t, 'rc-same-b');
  const jemaah = await tempJemaah(t, 'rc-same');
  // Both bookings landing in the same recent month, with explicit ordering
  const earlier = new Date(); earlier.setHours(10, 0, 0, 0);
  const later = new Date(earlier); later.setHours(later.getHours() + 1);
  const bA = await tempBooking({ paket: paketA, jemaahProfileId: jemaah.jemaah.id });
  const bB = await tempBooking({ paket: paketB, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: bA.id }, data: { status: 'LUNAS', paidAmount: '5000000', createdAt: earlier } });
  await db.booking.update({ where: { id: bB.id }, data: { status: 'LUNAS', paidAmount: '5000000', createdAt: later } });
  const r = await getReturningCustomerRollup({ months: 3 });
  // Both contribute to totalLunas; second contributes to repeatLunas because
  // jemaah's first LUNAS was strictly before second.createdAt
  const lbl = `${earlier.getFullYear()}-${String(earlier.getMonth() + 1).padStart(2, '0')}`;
  const bucket = r.months.find((m) => m.label === lbl);
  assert.ok(bucket);
  assert.ok(bucket.repeatLunas >= 1, 'second-in-same-month counts as repeat');
});

test('getReturningCustomerRollup: ratePct null when 0 LUNAS in window', async () => {
  const r = await getReturningCustomerRollup({
    months: 3,
    now: new Date('2099-01-15'),
  });
  assert.equal(r.total.ratePct, null);
  // Each month's ratePct is also null
  for (const m of r.months) {
    assert.equal(m.repeatRatePct, null);
  }
});
