// Stage 209 — booking duplicate check by NIK.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  findRecentBookingsByNik, normaliseNik,
} from '../src/services/bookingDuplicateCheck.js';

test('normaliseNik: strips non-digits', () => {
  assert.equal(normaliseNik('3201-9876-5432-1098'), '3201987654321098');
  assert.equal(normaliseNik('3201 9876 5432 1098'), '3201987654321098');
  assert.equal(normaliseNik('  3201987654321098  '), '3201987654321098');
});

test('normaliseNik: empty/null → empty string', () => {
  assert.equal(normaliseNik(''), '');
  assert.equal(normaliseNik(null), '');
  assert.equal(normaliseNik(undefined), '');
});

test('findRecentBookingsByNik: empty/short NIK → empty result', async () => {
  assert.deepEqual(await findRecentBookingsByNik({ nik: '' }), []);
  assert.deepEqual(await findRecentBookingsByNik({ nik: '123' }), []);
  assert.deepEqual(await findRecentBookingsByNik({}), []);
});

test('findRecentBookingsByNik: matches by exact normalized NIK', async (t) => {
  const tag = makeTag('s209-match');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: {
      fullName: `Jemaah ${tag}`, phone: '+62811',
      nik: '3201987654321098',
    },
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  // Hyphenated form still matches the stored form
  const r = await findRecentBookingsByNik({ nik: '3201-9876-5432-1098' });
  const mine = r.find((b) => b.id === booking.id);
  assert.ok(mine, 'NIK match found despite formatting');
});

test('findRecentBookingsByNik: excludes CANCELLED/REFUNDED', async (t) => {
  const tag = makeTag('s209-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: tag, phone: '+62811', nik: '3201111122223333' },
  });
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: cancelled.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const r = await findRecentBookingsByNik({ nik: '3201111122223333' });
  const mine = r.find((b) => b.id === cancelled.id);
  assert.equal(mine, undefined);
});

test('findRecentBookingsByNik: window excludes old bookings', async (t) => {
  const tag = makeTag('s209-old');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: tag, phone: '+62811', nik: '3201444455556666' },
  });
  const old = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-OLD`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'PENDING',
      createdAt: new Date('2020-01-01'),
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: old.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const r = await findRecentBookingsByNik({
    nik: '3201444455556666',
    now: new Date('2026-01-01'),
    windowDays: 90,
  });
  const mine = r.find((b) => b.id === old.id);
  assert.equal(mine, undefined);
});

test('findRecentBookingsByNik: returns booking + jemaah + paket + agent context', async (t) => {
  const tag = makeTag('s209-context');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: tag, phone: '+62811', nik: '3201777788889999' },
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });
  const r = await findRecentBookingsByNik({ nik: '3201777788889999' });
  const mine = r.find((b) => b.id === booking.id);
  assert.ok(mine);
  assert.ok(mine.paket?.title);
  assert.ok(mine.jemaah?.fullName);
});
