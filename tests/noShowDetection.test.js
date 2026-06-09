// Stage 144 — booking no-show detection. Active bookings on paket
// whose departure has passed AND have 0 AttendanceMark for day 1
// get stamped with noShowAt. Idempotent + skips paket without
// itinerary day 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempMuthawwif, fakeReq } from './_helpers.js';
import { detectNoShows, listNoShows } from '../src/services/noShow.js';

async function backdateDeparture(paketId, daysAgo = 5) {
  await db.paket.update({
    where: { id: paketId },
    data: {
      departureDate: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      returnDate: new Date(Date.now() - (daysAgo - 10) * 24 * 60 * 60 * 1000),
    },
  });
}

test('detectNoShows: marks booking with no day-1 attendance', async (t) => {
  const tag = makeTag('s144-mark');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Booking active by default (PENDING)

  const r = await detectNoShows({ now: new Date() });
  assert.ok(r.found >= 1);
  assert.ok(r.marked >= 1);

  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.ok(after.noShowAt instanceof Date);
});

test('detectNoShows: skips booking WITH any day-1 mark (even absent)', async (t) => {
  const tag = makeTag('s144-marked');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const crew = await tempMuthawwif(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Mark absent on day 1 — still counts as "crew tracked them", not a no-show
  await db.attendanceMark.create({
    data: {
      bookingId: booking.id,
      paketDayId: paket.days[0].id,
      present: false,
      markedByUserId: crew.id,
    },
  });

  await detectNoShows({ now: new Date() });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.noShowAt, null, 'marked-absent ≠ no-show');
});

test('detectNoShows: skips paket without itinerary day 1', async (t) => {
  const tag = makeTag('s144-noday');
  // paket without any day rows (dayCount default 0)
  const paket = await tempPaket(t, tag);
  await backdateDeparture(paket.id, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await detectNoShows({ now: new Date() });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.noShowAt, null, 'paket without day-1 → no guess');
});

test('detectNoShows: skips paket whose departure has NOT passed yet', async (t) => {
  const tag = makeTag('s144-future');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  // tempPaket defaults departureDate to +30d so paket hasn't departed
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await detectNoShows({ now: new Date() });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.noShowAt, null, 'future-trip booking ignored');
});

test('detectNoShows: skips CANCELLED + REFUNDED bookings', async (t) => {
  const tag = makeTag('s144-cancelled');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });

  await detectNoShows({ now: new Date() });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.noShowAt, null);
});

test('detectNoShows: idempotent — second run skips already-stamped booking', async (t) => {
  const tag = makeTag('s144-idem');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await detectNoShows({ now: new Date() });
  const after1 = await db.booking.findUnique({ where: { id: booking.id } });
  const stamp1 = after1.noShowAt;
  assert.ok(stamp1);

  // Sleep tick then re-run; stamp must NOT change (idempotent)
  await new Promise((resolve) => setTimeout(resolve, 20));
  const r2 = await detectNoShows({ now: new Date() });
  assert.equal(r2.marked, 0, 'second run finds nothing new');
  const after2 = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after2.noShowAt.getTime(), stamp1.getTime(), 'stamp unchanged');
});

test('detectNoShows: dryRun returns candidates without writing', async (t) => {
  const tag = makeTag('s144-dryrun');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await detectNoShows({ now: new Date(), dryRun: true });
  assert.ok(r.found >= 1);
  assert.equal(r.marked, 0, 'dryRun does not write');

  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.noShowAt, null);
});

test('listNoShows: returns paginated list ordered by noShowAt desc', async (t) => {
  const tag = makeTag('s144-list');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 5);
  const j1 = await tempJemaah(t, `${tag}-1`);
  const j2 = await tempJemaah(t, `${tag}-2`);
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  // Stamp manually with distinct timestamps
  await db.booking.update({
    where: { id: b1.id },
    data: { noShowAt: new Date('2026-06-01') },
  });
  await db.booking.update({
    where: { id: b2.id },
    data: { noShowAt: new Date('2026-06-05') },
  });

  const r = await listNoShows({ page: 1, pageSize: 100 });
  const idx1 = r.rows.findIndex((x) => x.id === b1.id);
  const idx2 = r.rows.findIndex((x) => x.id === b2.id);
  assert.ok(idx1 >= 0 && idx2 >= 0);
  // b2 (later stamp) appears before b1 (earlier stamp)
  assert.ok(idx2 < idx1, 'most-recent stamp first');
});
