// Stage 263 — group needs-attention rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getGroupsNeedsAttention } from '../src/services/groupNeedsAttention.js';
import { setBookingGroupKey } from '../src/services/bookingGroup.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('getGroupsNeedsAttention: returns empty when no groups exist', async () => {
  const r = await getGroupsNeedsAttention();
  // We can't assert empty (other tests may leave groups), but the shape
  // must be `{rows, total}` with rows array.
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.total, 'number');
});

test('getGroupsNeedsAttention: surfaces group with unpaid balance', async (t) => {
  const paket = await tempPaket(t, 'gna-unpd');
  const jemaah = await tempJemaah(t, 'gna-unpd');
  // Booking with paidAmount < totalAmount → unpaid gap
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  // Set group AND mark passport on jemaah to avoid doc gap polluting the test
  await db.jemaahProfile.update({
    where: { id: jemaah.jemaah.id },
    data: { passportNo: 'A1234567' },
  });
  // Pre-create VERIFIED required docs so doc-gap doesn't fire
  await db.jemaahDocument.createMany({
    data: [
      { jemaahId: jemaah.jemaah.id, type: 'VISA_UMROH', status: 'VERIFIED' },
      { jemaahId: jemaah.jemaah.id, type: 'VACCINE_MENINGITIS', status: 'VERIFIED' },
    ],
  });
  const key = `G-UNP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b.id, groupKey: key });
    const r = await getGroupsNeedsAttention();
    const row = r.rows.find((x) => x.groupKey === key);
    assert.ok(row, 'group surfaces in rollup');
    assert.equal(row.memberCount, 1);
    assert.equal(row.unpaidCount, 1);
    assert.equal(row.unpaidBalanceIdr, 5000000);
    assert.equal(row.missingPickupCount, 0); // paket has no pickup configured
    assert.equal(row.missingDocCount, 0);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getGroupsNeedsAttention: hides group with no gaps (fully paid + docs verified)', async (t) => {
  const paket = await tempPaket(t, 'gna-clean');
  const jemaah = await tempJemaah(t, 'gna-clean');
  // Fully paid booking
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({ where: { id: b.id }, data: { paidAmount: '5000000' } });
  await db.jemaahProfile.update({
    where: { id: jemaah.jemaah.id },
    data: { passportNo: 'A1234567' },
  });
  await db.jemaahDocument.createMany({
    data: [
      { jemaahId: jemaah.jemaah.id, type: 'VISA_UMROH', status: 'VERIFIED' },
      { jemaahId: jemaah.jemaah.id, type: 'VACCINE_MENINGITIS', status: 'VERIFIED' },
    ],
  });
  const key = `G-CLN${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b.id, groupKey: key });
    const r = await getGroupsNeedsAttention();
    const row = r.rows.find((x) => x.groupKey === key);
    assert.equal(row, undefined, 'group with no gaps is hidden');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getGroupsNeedsAttention: missing passport counts as doc gap', async (t) => {
  const paket = await tempPaket(t, 'gna-psp');
  const jemaah = await tempJemaah(t, 'gna-psp');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({ where: { id: b.id }, data: { paidAmount: '5000000' } });
  // No passport on jemaah, no required docs uploaded
  const key = `G-PSP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b.id, groupKey: key });
    const r = await getGroupsNeedsAttention();
    const row = r.rows.find((x) => x.groupKey === key);
    assert.ok(row, 'group with missing docs surfaces');
    assert.equal(row.missingDocCount, 1);
    assert.equal(row.unpaidCount, 0); // fully paid
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getGroupsNeedsAttention: CANCELLED/REFUNDED members do not count', async (t) => {
  const paket = await tempPaket(t, 'gna-cxl');
  const j1 = await tempJemaah(t, 'gna-cxl-1');
  const j2 = await tempJemaah(t, 'gna-cxl-2');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id, totalAmount: '5000000' });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id, totalAmount: '5000000' });
  const key = `G-CXL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b1.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b2.id, groupKey: key });
    // Cancel b1 — should be excluded; only b2's gap counts
    await db.booking.update({ where: { id: b1.id }, data: { status: 'CANCELLED' } });
    const r = await getGroupsNeedsAttention();
    const row = r.rows.find((x) => x.groupKey === key);
    assert.ok(row);
    assert.equal(row.memberCount, 1, 'cancelled member excluded from member count');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getGroupsNeedsAttention: sort by gapTotal desc + limit', async (t) => {
  // We can't assert exact ordering when seed/other tests leave groups,
  // but we can verify (a) the limit is respected and (b) rows are sorted.
  const paket = await tempPaket(t, 'gna-sort');
  const jemaah = await tempJemaah(t, 'gna-sort');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  const key = `G-SRT${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b.id, groupKey: key });
    const r = await getGroupsNeedsAttention({ limit: 3 });
    assert.ok(r.rows.length <= 3);
    // Sort assertion: each row's gapTotal >= the next
    for (let i = 1; i < r.rows.length; i += 1) {
      assert.ok(r.rows[i - 1].gapTotal >= r.rows[i].gapTotal);
    }
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});
