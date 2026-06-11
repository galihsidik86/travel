// Stage 199 — print manifest age column. Verifies getPrintManifest
// attaches age + ageBracket to each jemaah and rolls up lansia/anak
// counts in the header.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getPrintManifest } from '../src/services/adminDashboard.js';

// Helper: build a booking with a jemaah of a specific age at departure
async function bookingWithAge(t, paket, age) {
  // birthDate = departureDate - age years
  const dep = new Date(paket.departureDate);
  const birth = new Date(dep);
  birth.setFullYear(dep.getFullYear() - age);
  const jem = await db.jemaahProfile.create({
    data: {
      fullName: `Test ${age}y ${Math.random().toString(36).slice(2, 5)}`,
      phone: '+62811',
      birthDate: birth,
    },
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });
  return booking;
}

test('getPrintManifest: attaches age + ageBracket per jemaah', async (t) => {
  const tag = makeTag('s199-age');
  const paket = await tempPaket(t, tag);
  await bookingWithAge(t, paket, 8);    // anak
  await bookingWithAge(t, paket, 35);   // dewasa
  await bookingWithAge(t, paket, 65);   // lansia

  const m = await getPrintManifest(paket.slug);
  const ages = m.bookings.map((b) => b.jemaah.ageBracket).sort();
  assert.deepEqual(ages, ['ANAK', 'DEWASA', 'LANSIA']);
  assert.equal(m.counts.lansiaCount, 1);
  assert.equal(m.counts.anakCount, 1);
});

test('getPrintManifest: unknown birthDate → UNKNOWN bracket + null age', async (t) => {
  const tag = makeTag('s199-unknown');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // tempJemaah doesn't set birthDate → null
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
  });

  const m = await getPrintManifest(paket.slug);
  const mine = m.bookings.find((b) => b.id === booking.id);
  assert.equal(mine.jemaah.age, null);
  assert.equal(mine.jemaah.ageBracket, 'UNKNOWN');
});

test('getPrintManifest: lansiaCount/anakCount are zero when only dewasa', async (t) => {
  const tag = makeTag('s199-zero');
  const paket = await tempPaket(t, tag);
  await bookingWithAge(t, paket, 30);
  await bookingWithAge(t, paket, 45);

  const m = await getPrintManifest(paket.slug);
  assert.equal(m.counts.lansiaCount, 0);
  assert.equal(m.counts.anakCount, 0);
});

test('getPrintManifest: CANCELLED bookings excluded from age math', async (t) => {
  const tag = makeTag('s199-cancel');
  const paket = await tempPaket(t, tag);
  const dep = new Date(paket.departureDate);
  const birth = new Date(dep);
  birth.setFullYear(dep.getFullYear() - 70); // lansia
  const jem = await db.jemaahProfile.create({
    data: { fullName: 'Cancelled lansia', phone: '+62811', birthDate: birth },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { jemaahId: jem.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const m = await getPrintManifest(paket.slug);
  // CANCELLED booking excluded entirely
  assert.equal(m.counts.lansiaCount, 0);
});
