// Stage 297 — adjustment ledger rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { addBookingAdjustment } from '../src/services/bookingAdjustments.js';
import { getAdjustmentLedger } from '../src/services/adjustmentLedger.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('getAdjustmentLedger: returns empty shape on no data', async () => {
  // Hard to guarantee empty in the test DB, but verify shape contract
  const r = await getAdjustmentLedger({ days: 90 });
  assert.ok(Array.isArray(r.perReason));
  assert.ok(Array.isArray(r.topActors));
  assert.equal(typeof r.totals.discountIdr, 'number');
  assert.equal(typeof r.totals.surchargeIdr, 'number');
  assert.equal(typeof r.totals.netIdr, 'number');
});

test('getAdjustmentLedger: groups by reasonCode + splits kinds', async (t) => {
  const paket = await tempPaket(t, 'aledg-grp');
  const jemaah = await tempJemaah(t, 'aledg-grp');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  // 1x DISCOUNT promo 200k
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-grp-owner@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 200000, reasonCode: 'PROMO',
  });
  // 1x SURCHARGE correction 100k
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-grp-owner@test', role: 'OWNER' },
    bookingId: b.id, kind: 'SURCHARGE', amountIdr: 100000, reasonCode: 'CORRECTION',
  });
  const r = await getAdjustmentLedger({ days: 90 });
  const promo = r.perReason.find((p) => p.reasonCode === 'PROMO');
  const corr = r.perReason.find((p) => p.reasonCode === 'CORRECTION');
  assert.ok(promo);
  assert.ok(corr);
  assert.ok(promo.discountIdr >= 200000);
  assert.equal(promo.surchargeIdr >= 0, true);
  assert.ok(corr.surchargeIdr >= 100000);
});

test('getAdjustmentLedger: excludes adjustments on CANCELLED booking', async (t) => {
  const paket = await tempPaket(t, 'aledg-cxl');
  const jemaah = await tempJemaah(t, 'aledg-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-cxl-actor@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 999999, reasonCode: 'GOODWILL',
  });
  // Now cancel the booking — the adjustment should drop out of the ledger
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  const r = await getAdjustmentLedger({ days: 90 });
  // The 999999 PROMO amount we just added is distinctive — verify it's not in the rollup
  const distinctActor = r.topActors.find((a) => a.email === 'aledg-cxl-actor@test');
  assert.equal(distinctActor, undefined, 'cancelled-booking actor excluded');
});

test('getAdjustmentLedger: topActors sorted by total absolute amount', async (t) => {
  const paket = await tempPaket(t, 'aledg-actor');
  const jemaah = await tempJemaah(t, 'aledg-actor');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '20000000' });
  // Three distinct actors, increasing amounts (PROMO doesn't push below paidAmount since paidAmount=0)
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-small@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'PROMO',
  });
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-mid@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 500000, reasonCode: 'PROMO',
  });
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-big@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 2000000, reasonCode: 'GOODWILL',
  });
  const r = await getAdjustmentLedger({ days: 90 });
  const bigIdx = r.topActors.findIndex((a) => a.email === 'aledg-big@test');
  const midIdx = r.topActors.findIndex((a) => a.email === 'aledg-mid@test');
  const smallIdx = r.topActors.findIndex((a) => a.email === 'aledg-small@test');
  assert.ok(bigIdx >= 0);
  assert.ok(midIdx >= 0);
  assert.ok(smallIdx >= 0);
  assert.ok(bigIdx < midIdx, 'big-actor before mid-actor');
  assert.ok(midIdx < smallIdx, 'mid-actor before small-actor');
});

test('getAdjustmentLedger: net totals — discount counts as -ve impact, surcharge as +ve', async (t) => {
  const paket = await tempPaket(t, 'aledg-net');
  const jemaah = await tempJemaah(t, 'aledg-net');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const beforeR = await getAdjustmentLedger({ days: 90 });
  const beforeNet = beforeR.totals.netIdr;
  // Add only a DISCOUNT — net should decrease
  await addBookingAdjustment({
    req: ownerReq, actor: { id: null, email: 'aledg-net-actor@test', role: 'OWNER' },
    bookingId: b.id, kind: 'DISCOUNT', amountIdr: 500000, reasonCode: 'PROMO',
  });
  const afterR = await getAdjustmentLedger({ days: 90 });
  // The 500k discount we just added should subtract 500k from net
  assert.ok(afterR.totals.netIdr <= beforeNet - 500000 + 1); // ±1 for rounding leniency
});
