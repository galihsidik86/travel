// Stage 72 — ICS export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { generateBookingIcs } from '../src/services/bookingIcs.js';

async function setupLunas(t, tag) {
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: {
      departureDate: new Date(Date.UTC(2027, 5, 1)),  // 1 Jun 2027
      returnDate:    new Date(Date.UTC(2027, 5, 14)), // 14 Jun 2027
      airline: 'Garuda',
      routeFrom: 'CGK',
      routeTo: 'JED',
    },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-ICS`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 2, totalAmount: '5000000', paidAmount: '5000000',
      status: 'LUNAS',
    },
  });
  return { user: jem, paket, booking: b };
}

test('returns null for cross-user access (jemaahUserId mismatch → 404)', async (t) => {
  const tag = makeTag('ics-cross');
  const { booking } = await setupLunas(t, tag);
  const intruder = await tempJemaah(t, `${tag}-i`);
  const r = await generateBookingIcs({
    userId: intruder.id, bookingId: booking.id,
  });
  assert.equal(r, null, 'must 404 for non-owner');
});

test('emits VCALENDAR with VEVENT + paket title in SUMMARY', async (t) => {
  const tag = makeTag('ics-emit');
  const { user, booking } = await setupLunas(t, tag);
  const r = await generateBookingIcs({
    userId: user.id, bookingId: booking.id,
  });
  assert.ok(r);
  assert.match(r.filename, /\.ics$/);
  assert.match(r.body, /^BEGIN:VCALENDAR\r\n/);
  assert.match(r.body, /END:VCALENDAR\r\n$/);
  assert.match(r.body, /BEGIN:VEVENT/);
  assert.match(r.body, /SUMMARY:🕋/); // emoji preserved
  // Departure: 2027-06-01 → DTSTART;VALUE=DATE:20270601
  assert.match(r.body, /DTSTART;VALUE=DATE:20270601/);
  // DTEND is exclusive — return 14 Jun + 1 day = 15 Jun
  assert.match(r.body, /DTEND;VALUE=DATE:20270615/);
  // Description carries booking metadata
  assert.match(r.body, /Booking RP-/);
  assert.match(r.body, /Kelas QUAD/);
  assert.match(r.body, /Maskapai Garuda/);
  // Stable UID
  assert.match(r.body, new RegExp(`UID:${booking.id}@religio-pro`));
});

test('escapes special chars per RFC 5545', async (t) => {
  const tag = makeTag('ics-escape');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: {
      title: 'Tour; comma, & semicolon',
      departureDate: new Date(Date.UTC(2027, 5, 1)),
      returnDate:    new Date(Date.UTC(2027, 5, 7)),
    },
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-ESC`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  const r = await generateBookingIcs({ userId: jem.id, bookingId: b.id });
  assert.ok(r);
  // ; and , must be escaped with backslash
  assert.match(r.body, /Tour\\;\s*comma\\,/);
});
