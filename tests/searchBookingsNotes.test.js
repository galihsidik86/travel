// Stage 184 — substring search on Booking.notes via the existing
// /admin/bookings search service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { searchBookings } from '../src/services/bookingsSearch.js';

async function bookingWithNotes(t, tag, notes) {
  const paket = await tempPaket(t, makeTag(`${tag}-p`));
  const jem = await tempJemaah(t, makeTag(`${tag}-j`));
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { notes } });
  return b;
}

test('searchBookings: empty notes filter → all matches', async (t) => {
  const tag = makeTag('s184-empty');
  const b = await bookingWithNotes(t, tag, 'wheelchair perlu');
  const r = await searchBookings({ q: b.bookingNo });
  assert.equal(r.total, 1);
});

test('searchBookings: notes filter with <3 chars silently ignored', async (t) => {
  const tag = makeTag('s184-short');
  const b1 = await bookingWithNotes(t, tag, 'wheelchair');
  const b2 = await bookingWithNotes(t, tag, 'mahram');
  // 2-char query → no filter applied, both rows match by tag
  const r = await searchBookings({ q: tag, notes: 'wh' });
  const ids = r.rows.map((b) => b.id);
  assert.ok(ids.includes(b1.id));
  assert.ok(ids.includes(b2.id), '2-char filter ignored (returns all)');
});

test('searchBookings: notes filter (3+ chars) narrows results', async (t) => {
  const tag = makeTag('s184-narrow');
  const matching = await bookingWithNotes(t, tag, 'jemaah lansia perlu kursi roda');
  const other = await bookingWithNotes(t, tag, 'permintaan mahram berdua');
  const r = await searchBookings({ q: tag, notes: 'lansia' });
  const ids = r.rows.map((b) => b.id);
  assert.ok(ids.includes(matching.id), 'matched booking surfaced');
  assert.ok(!ids.includes(other.id), 'non-matching excluded');
});

test('searchBookings: notes search is substring (not exact)', async (t) => {
  const tag = makeTag('s184-substr');
  const b = await bookingWithNotes(t, tag, 'minta kursi-roda untuk ayah');
  const r = await searchBookings({ q: tag, notes: 'kursi' });
  const ids = r.rows.map((row) => row.id);
  assert.ok(ids.includes(b.id), 'substring matched');
});

test('searchBookings: notes filter trims whitespace', async (t) => {
  const tag = makeTag('s184-trim');
  const b = await bookingWithNotes(t, tag, 'manasik tambahan');
  const r = await searchBookings({ q: tag, notes: '   manasik   ' });
  const ids = r.rows.map((row) => row.id);
  assert.ok(ids.includes(b.id), 'whitespace trimmed before matching');
});

test('searchBookings: notes filter with empty/null booking notes → row excluded', async (t) => {
  const tag = makeTag('s184-null');
  const withNotes = await bookingWithNotes(t, tag, 'special request');
  const paket = await tempPaket(t, makeTag(`${tag}-p2`));
  const jem = await tempJemaah(t, makeTag(`${tag}-j2`));
  const withoutNotes = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // withoutNotes.notes is null/empty
  const r = await searchBookings({ q: tag, notes: 'special' });
  const ids = r.rows.map((row) => row.id);
  assert.ok(ids.includes(withNotes.id));
  assert.ok(!ids.includes(withoutNotes.id));
});
