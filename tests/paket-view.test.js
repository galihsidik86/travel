// Stage 48 — paket view tracking + conversion summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { recordPaketView, getPaketConversion } from '../src/services/paketView.js';

const ONE_DAY_MS = 86_400_000;

test('recordPaketView is idempotent for the same (paket, visitor, day)', async (t) => {
  const tag = makeTag('pv-idem');
  const paket = await tempPaket(t, tag);
  const visitorId = 'a'.repeat(32);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });

  await recordPaketView({ paketId: paket.id, visitorId });
  await recordPaketView({ paketId: paket.id, visitorId });
  await recordPaketView({ paketId: paket.id, visitorId });

  const count = await db.paketView.count({ where: { paketId: paket.id } });
  assert.equal(count, 1, 'repeat visits same day must collapse to one row');
});

test('recordPaketView creates separate rows per visitor', async (t) => {
  const tag = makeTag('pv-multi');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  await recordPaketView({ paketId: paket.id, visitorId: 'a'.repeat(32) });
  await recordPaketView({ paketId: paket.id, visitorId: 'b'.repeat(32) });
  await recordPaketView({ paketId: paket.id, visitorId: 'c'.repeat(32) });

  const count = await db.paketView.count({ where: { paketId: paket.id } });
  assert.equal(count, 3);
});

test('recordPaketView returns null on missing params (defensive)', async () => {
  assert.equal(await recordPaketView({ paketId: null, visitorId: 'a' }), null);
  assert.equal(await recordPaketView({ paketId: 'x', visitorId: '' }), null);
});

test('getPaketConversion computes conversion as bookings/visits %', async (t) => {
  const tag = makeTag('pv-conv');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 5 unique visitors, 1 booking → 20%
  for (let i = 0; i < 5; i++) {
    await recordPaketView({ paketId: paket.id, visitorId: String(i).padStart(32, '0') });
  }
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const out = await getPaketConversion({ days: 30, limit: 100 });
  const row = out.rows.find((r) => r.paket.slug === paket.slug);
  assert.ok(row);
  assert.equal(row.visits, 5);
  assert.equal(row.bookings, 1);
  assert.equal(row.conversionPct, 20.0);
});

test('getPaketConversion conversionPct=null when zero visits but ≥1 booking', async (t) => {
  const tag = makeTag('pv-zero');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  // Booking but no view rows
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const out = await getPaketConversion({ days: 30, limit: 100 });
  const row = out.rows.find((r) => r.paket.slug === paket.slug);
  assert.ok(row, 'row must appear because bookings > 0');
  assert.equal(row.visits, 0);
  assert.equal(row.bookings, 1);
  assert.equal(row.conversionPct, null, 'pct must be null when visits=0 to avoid divide-by-zero');
});

test('cancelled bookings excluded from conversion count', async (t) => {
  const tag = makeTag('pv-cancel');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  await recordPaketView({ paketId: paket.id, visitorId: 'x'.repeat(32) });
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: b.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  const out = await getPaketConversion({ days: 30, limit: 100 });
  const row = out.rows.find((r) => r.paket.slug === paket.slug);
  assert.ok(row, 'row appears because visits > 0');
  assert.equal(row.bookings, 0, 'CANCELLED booking must NOT count');
});
