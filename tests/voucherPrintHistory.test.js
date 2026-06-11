// Stage 198 — voucher print history counter + lastAt + lastByEmail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { recordVoucherPrint } from '../src/services/voucherPrintHistory.js';

test('new booking: counters initialised to 0/null', async (t) => {
  const tag = makeTag('s198-init');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const row = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(row.voucherPrintCount, 0);
  assert.equal(row.lastVoucherPrintedAt, null);
  assert.equal(row.lastVoucherPrintedByEmail, null);
});

test('recordVoucherPrint: bumps counter + stamps timestamp + email', async (t) => {
  const tag = makeTag('s198-bump');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await recordVoucherPrint({ bookingId: booking.id, actorEmail: 'admin@example.test' });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.voucherPrintCount, 1);
  assert.ok(after.lastVoucherPrintedAt instanceof Date);
  assert.equal(after.lastVoucherPrintedByEmail, 'admin@example.test');
});

test('recordVoucherPrint: multiple calls cumulate', async (t) => {
  const tag = makeTag('s198-multi');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  for (let i = 0; i < 4; i++) {
    await recordVoucherPrint({ bookingId: booking.id, actorEmail: 'a@example.test' });
  }
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.voucherPrintCount, 4);
});

test('recordVoucherPrint: latest actor wins on each bump', async (t) => {
  const tag = makeTag('s198-actor');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await recordVoucherPrint({ bookingId: booking.id, actorEmail: 'first@example.test' });
  await recordVoucherPrint({ bookingId: booking.id, actorEmail: 'second@example.test' });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.lastVoucherPrintedByEmail, 'second@example.test');
  assert.equal(after.voucherPrintCount, 2);
});

test('recordVoucherPrint: anonymous (null email) accepted', async (t) => {
  const tag = makeTag('s198-anon');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await recordVoucherPrint({ bookingId: booking.id });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.voucherPrintCount, 1);
  assert.equal(after.lastVoucherPrintedByEmail, null);
});

test('recordVoucherPrint: missing bookingId → no-op (no throw)', async () => {
  await recordVoucherPrint({ bookingId: null });
  await recordVoucherPrint({});
});

test('recordVoucherPrint: non-existent booking → swallowed', async () => {
  // Best-effort: a missing row throws in Prisma but the helper catches it
  await recordVoucherPrint({ bookingId: 'does-not-exist', actorEmail: 'x@y.test' });
});
