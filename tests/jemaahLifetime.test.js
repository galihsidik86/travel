// Stage 292 — jemaah lifetime panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getJemaahLifetime } from '../src/services/jemaahLifetime.js';

test('getJemaahLifetime: null on missing id', async () => {
  assert.equal(await getJemaahLifetime(null), null);
  assert.equal(await getJemaahLifetime(''), null);
  assert.equal(await getJemaahLifetime('cknotexist'), null);
});

test('getJemaahLifetime: zero-booking jemaah returns empty shape', async (t) => {
  const jemaah = await tempJemaah(t, 'jl-zero');
  const r = await getJemaahLifetime(jemaah.jemaah.id);
  assert.ok(r);
  assert.equal(r.bookings.length, 0);
  assert.equal(r.totals.tripCount, 0);
  assert.equal(r.totals.lunasCount, 0);
  assert.equal(r.repeatFlag, false);
});

test('getJemaahLifetime: aggregates totals across mixed-status bookings', async (t) => {
  const paket = await tempPaket(t, 'jl-mix');
  const jemaah = await tempJemaah(t, 'jl-mix');
  const b1 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  const b2 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '7000000' });
  const b3 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '3000000' });
  await db.booking.update({ where: { id: b1.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  await db.booking.update({ where: { id: b2.id }, data: { status: 'CANCELLED' } });
  await db.booking.update({ where: { id: b3.id }, data: { status: 'PARTIAL', paidAmount: '1500000' } });

  const r = await getJemaahLifetime(jemaah.jemaah.id);
  assert.equal(r.totals.tripCount, 3);
  assert.equal(r.totals.lunasCount, 1);
  assert.equal(r.totals.cancelledCount, 1);
  assert.equal(r.totals.activeCount, 2, 'LUNAS + PARTIAL count as active');
  assert.equal(r.totals.lifetimeRevenueIdr, 5000000, 'only LUNAS counts toward lifetime revenue');
  assert.equal(r.totals.lifetimePaidIdr, 6500000, 'paid sum across active bookings');
  assert.equal(r.repeatFlag, false, 'one LUNAS != repeat');
});

test('getJemaahLifetime: repeatFlag true when lunasCount >= 2', async (t) => {
  const paket = await tempPaket(t, 'jl-repeat');
  const jemaah = await tempJemaah(t, 'jl-repeat');
  const b1 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  await db.booking.update({ where: { id: b2.id }, data: { status: 'LUNAS', paidAmount: '5000000' } });
  const r = await getJemaahLifetime(jemaah.jemaah.id);
  assert.equal(r.repeatFlag, true);
  assert.equal(r.totals.lunasCount, 2);
});

test('getJemaahLifetime: bookings sorted newest-first', async (t) => {
  const paket = await tempPaket(t, 'jl-sort');
  const jemaah = await tempJemaah(t, 'jl-sort');
  // Create 3 bookings with deterministic order; verify newest-first
  const b1 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // Force b1's createdAt earlier
  await db.booking.update({
    where: { id: b1.id }, data: { createdAt: new Date(Date.now() - 86400_000 * 5) },
  });
  const r = await getJemaahLifetime(jemaah.jemaah.id);
  assert.equal(r.bookings.length, 2);
  assert.equal(r.bookings[0].id, b2.id, 'newest first');
  assert.equal(r.bookings[1].id, b1.id);
});

test('getJemaahLifetime: siblingProfiles surfaces other jemaah with same phone', async (t) => {
  const tag = `jl-sib-${Math.random().toString(36).slice(2, 6)}`;
  // Make two jemaah profiles with the SAME phone (different format)
  const jA = await tempJemaah(t, tag + '-a');
  const jB = await tempJemaah(t, tag + '-b');
  // Force matching normalised phone digits
  const phone = '0812-3456-7890';
  await db.jemaahProfile.update({ where: { id: jA.jemaah.id }, data: { phone: '+62 812 3456 7890' } });
  await db.jemaahProfile.update({ where: { id: jB.jemaah.id }, data: { phone } });

  const r = await getJemaahLifetime(jA.jemaah.id);
  const siblingIds = r.siblingProfiles.map((s) => s.id);
  assert.ok(siblingIds.includes(jB.jemaah.id), 'B surfaces as sibling of A');
});

test('getJemaahLifetime: zero-padded phone vs +62 still matches as siblings', async (t) => {
  const tag = `jl-pad-${Math.random().toString(36).slice(2, 6)}`;
  const jA = await tempJemaah(t, tag + '-a');
  const jB = await tempJemaah(t, tag + '-b');
  // Test 0xxx vs 62xxx normalisation
  await db.jemaahProfile.update({ where: { id: jA.jemaah.id }, data: { phone: '0811-9988-7766' } });
  await db.jemaahProfile.update({ where: { id: jB.jemaah.id }, data: { phone: '62811-9988-7766' } });
  const r = await getJemaahLifetime(jA.jemaah.id);
  const siblingIds = r.siblingProfiles.map((s) => s.id);
  assert.ok(siblingIds.includes(jB.jemaah.id), '0/62 normalisation matches as siblings');
});
