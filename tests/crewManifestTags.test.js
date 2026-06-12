// Stage 231 — booking tags visible on crew manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempMuthawwif, tempBooking } from './_helpers.js';
import { getAssignedManifest } from '../src/services/crewPortal.js';

test('getAssignedManifest: bookings include tags field', async (t) => {
  const tag = makeTag('s231-field');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { tags: ['VIP', 'LANSIA'] } });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.deepEqual(r.bookings[0].tags, ['VIP', 'LANSIA']);
});

test('getAssignedManifest: bookings with null tags expose null/empty (no crash)', async (t) => {
  const tag = makeTag('s231-null');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  // tags is null when not set; view treats non-array as empty
  assert.ok(r.bookings[0].tags === null || Array.isArray(r.bookings[0].tags));
});

test('getAssignedManifest: tags preserved across CANCELLED filter', async (t) => {
  const tag = makeTag('s231-cancelled');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
  const u = await tempJemaah(t, tag);
  // ACTIVE with tags
  const b1 = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { tags: ['VIP'] } });
  // CANCELLED — should be excluded from manifest entirely
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED', tags: ['HONEYMOON'],
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: cancelled.id } }); });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  // Only ACTIVE booking with VIP tag visible
  assert.equal(r.bookings.length, 1);
  assert.deepEqual(r.bookings[0].tags, ['VIP']);
});
