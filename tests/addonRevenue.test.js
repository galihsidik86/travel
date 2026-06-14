// Stage 285 — admin add-on revenue rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { createPaketAddon } from '../src/services/paketAddons.js';
import { attachBookingAddon } from '../src/services/bookingAddons.js';
import { getAddonRevenueRollup } from '../src/services/addonRevenue.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('getAddonRevenueRollup: returns shape on empty', async () => {
  // Hard to guarantee fully empty if other tests leak data — just verify shape
  const r = await getAddonRevenueRollup();
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.totals.attachCount, 'number');
  assert.equal(typeof r.totals.totalQuantity, 'number');
  assert.equal(typeof r.totals.revenueIdr, 'number');
});

test('getAddonRevenueRollup: groups by nameSnapshot + sorts revenue desc', async (t) => {
  const paket = await tempPaket(t, 'arev-grp');
  const jemaah = await tempJemaah(t, 'arev-grp');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const baggage = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'arev-grp-Baggage', priceIdr: 500000 },
  });
  const upgrade = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'arev-grp-Upgrade', priceIdr: 2000000 },
  });
  // baggage × 2 → 1,000,000
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, addonId: baggage.id, quantity: 2,
  });
  // upgrade × 1 → 2,000,000
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, addonId: upgrade.id, quantity: 1,
  });
  const r = await getAddonRevenueRollup();
  const baggageRow = r.rows.find((x) => x.name === 'arev-grp-Baggage');
  const upgradeRow = r.rows.find((x) => x.name === 'arev-grp-Upgrade');
  assert.ok(baggageRow);
  assert.ok(upgradeRow);
  assert.equal(baggageRow.revenueIdr, 1000000);
  assert.equal(baggageRow.totalQuantity, 2);
  assert.equal(upgradeRow.revenueIdr, 2000000);
  // upgrade revenue > baggage revenue → upgrade should sort first
  const upIdx = r.rows.findIndex((x) => x.name === 'arev-grp-Upgrade');
  const bgIdx = r.rows.findIndex((x) => x.name === 'arev-grp-Baggage');
  assert.ok(upIdx < bgIdx, 'upgrade (higher revenue) comes before baggage');
});

test('getAddonRevenueRollup: excludes CANCELLED/REFUNDED bookings', async (t) => {
  const paket = await tempPaket(t, 'arev-cxl');
  const jemaah = await tempJemaah(t, 'arev-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const addon = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'arev-cxl-cancelled-addon', priceIdr: 500000 },
  });
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, addonId: addon.id, quantity: 1,
  });
  // Now cancel the booking
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  const r = await getAddonRevenueRollup();
  const row = r.rows.find((x) => x.name === 'arev-cxl-cancelled-addon');
  assert.equal(row, undefined, 'cancelled booking\'s addon excluded');
});

test('getAddonRevenueRollup: per-row carries distinct paketCount', async (t) => {
  const paketA = await tempPaket(t, 'arev-pkt-a');
  const paketB = await tempPaket(t, 'arev-pkt-b');
  const jA = await tempJemaah(t, 'arev-pkt-a-j');
  const jB = await tempJemaah(t, 'arev-pkt-b-j');
  const bA = await tempBooking({ paket: paketA, jemaahProfileId: jA.jemaah.id, totalAmount: '10000000' });
  const bB = await tempBooking({ paket: paketB, jemaahProfileId: jB.jemaah.id, totalAmount: '10000000' });
  // Same-name addon on TWO different paket
  const addonA = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paketA.slug,
    input: { name: 'arev-multi-pkt-addon', priceIdr: 100000 },
  });
  const addonB = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paketB.slug,
    input: { name: 'arev-multi-pkt-addon', priceIdr: 100000 },
  });
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: bA.id, addonId: addonA.id, quantity: 1,
  });
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: bB.id, addonId: addonB.id, quantity: 1,
  });
  const r = await getAddonRevenueRollup();
  const row = r.rows.find((x) => x.name === 'arev-multi-pkt-addon');
  assert.ok(row);
  assert.equal(row.paketCount, 2, 'distinct paket count');
  assert.equal(row.attachCount, 2);
});
