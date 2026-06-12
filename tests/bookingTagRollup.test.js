// Stage 230 — booking tag aggregate KPI for admin overview.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getBookingTagRollup } from '../src/services/bookingTagRollup.js';

async function tagBooking(bookingId, tags) {
  await db.booking.update({ where: { id: bookingId }, data: { tags } });
}

test('getBookingTagRollup: empty result has shape', async () => {
  const r = await getBookingTagRollup();
  assert.ok(Array.isArray(r.tags));
  assert.equal(typeof r.totalTaggedBookings, 'number');
});

test('getBookingTagRollup: counts paxCount per tag', async (t) => {
  const tag = makeTag('s230-count');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tagBooking(b1.id, ['VIP']);
  await tagBooking(b2.id, ['VIP']);

  const r = await getBookingTagRollup();
  const vipRow = r.tags.find((t) => t.tag === 'VIP');
  assert.ok(vipRow);
  // Should be at least 2 bookings + 2 pax (test isolation: only tagged in this test)
  assert.ok(vipRow.bookings >= 2);
  assert.ok(vipRow.paxCount >= 2);
});

test('getBookingTagRollup: multi-tag bookings counted under each tag', async (t) => {
  const tag = makeTag('s230-multi');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tagBooking(b.id, ['VIP', 'HONEYMOON']);

  const r = await getBookingTagRollup();
  const vipRow = r.tags.find((tt) => tt.tag === 'VIP');
  const honeyRow = r.tags.find((tt) => tt.tag === 'HONEYMOON');
  // Both tags should include this booking
  assert.ok(vipRow && vipRow.bookings >= 1);
  assert.ok(honeyRow && honeyRow.bookings >= 1);
});

test('getBookingTagRollup: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s230-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Create a CANCELLED booking with a unique tag
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
      tags: [`SPECIAL-${tag.toUpperCase()}`],
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: cancelled.id } }); });

  const r = await getBookingTagRollup();
  // Unique tag with no other rows shouldn't appear
  const uniqueRow = r.tags.find((tt) => tt.tag === `SPECIAL-${tag.toUpperCase()}`);
  assert.equal(uniqueRow, undefined);
});

test('getBookingTagRollup: ARCHIVED paket bookings excluded', async (t) => {
  const tag = makeTag('s230-archived');
  // Create archived paket directly
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: 'X', departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ARCHIVED',
    },
  });
  const jem = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'PENDING',
      tags: [`ARCH-${tag.toUpperCase()}`],
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: b.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const r = await getBookingTagRollup();
  const archRow = r.tags.find((tt) => tt.tag === `ARCH-${tag.toUpperCase()}`);
  assert.equal(archRow, undefined);
});

test('getBookingTagRollup: paketCount counts distinct paket per tag', async (t) => {
  const tag = makeTag('s230-spread');
  const p1 = await tempPaket(t, tag + '-a');
  const p2 = await tempPaket(t, tag + '-b');
  const jem = await tempJemaah(t, tag);
  const b1 = await tempBooking({ paket: p1, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket: p2, jemaahProfileId: jem.jemaah.id });
  // Use a unique tag specific to this test so we can isolate the count
  const uniq = `SPREAD-${tag.toUpperCase()}`;
  await tagBooking(b1.id, [uniq]);
  await tagBooking(b2.id, [uniq]);

  const r = await getBookingTagRollup();
  const row = r.tags.find((tt) => tt.tag === uniq);
  assert.ok(row);
  assert.equal(row.bookings, 2);
  assert.equal(row.paketCount, 2);
});

test('getBookingTagRollup: sorts by paxCount desc', async (t) => {
  const tag = makeTag('s230-sort');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // 3 bookings with TAG-A, 1 booking with TAG-B (both unique to this test)
  const tagA = `ZA-${tag.toUpperCase()}`;
  const tagB = `ZB-${tag.toUpperCase()}`;
  for (let i = 0; i < 3; i += 1) {
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await tagBooking(b.id, [tagA]);
  }
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tagBooking(b.id, [tagB]);

  const r = await getBookingTagRollup();
  const idxA = r.tags.findIndex((tt) => tt.tag === tagA);
  const idxB = r.tags.findIndex((tt) => tt.tag === tagB);
  assert.ok(idxA >= 0 && idxB >= 0);
  // A (paxCount=3) should sort BEFORE B (paxCount=1) in the same result
  assert.ok(idxA < idxB);
});
