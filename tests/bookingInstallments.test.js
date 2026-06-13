// Stage 268 + 269 — booking installment schedule + reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  normaliseSchedule,
  summariseSchedule,
  applyPaymentToSchedule,
  setBookingInstallmentSchedule,
  suggestInstallmentPlan,
} from '../src/services/bookingInstallments.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

// ── normaliseSchedule ───────────────────────────────────────────

test('normaliseSchedule: null/empty → null', () => {
  assert.equal(normaliseSchedule(null), null);
  assert.equal(normaliseSchedule([]), null);
});

test('normaliseSchedule: rejects non-array', () => {
  assert.throws(
    () => normaliseSchedule({ foo: 'bar' }),
    (err) => err.code === 'INSTALLMENT_NOT_ARRAY' && err.status === 400,
  );
});

test('normaliseSchedule: rejects > 24 entries', () => {
  const big = Array.from({ length: 25 }, (_, i) => ({
    dueDate: '2026-06-01', amountIdr: 1000000, status: 'PENDING',
  }));
  assert.throws(
    () => normaliseSchedule(big),
    (err) => err.code === 'INSTALLMENT_TOO_MANY' && err.status === 400,
  );
});

test('normaliseSchedule: rejects bad dueDate', () => {
  assert.throws(
    () => normaliseSchedule([{ dueDate: '06/01/2026', amountIdr: 1000000 }]),
    (err) => err.code === 'INSTALLMENT_BAD_DATE' && err.status === 400,
  );
});

test('normaliseSchedule: rejects bad amount', () => {
  assert.throws(
    () => normaliseSchedule([{ dueDate: '2026-06-01', amountIdr: 0 }]),
    (err) => err.code === 'INSTALLMENT_BAD_AMOUNT' && err.status === 400,
  );
  assert.throws(
    () => normaliseSchedule([{ dueDate: '2026-06-01', amountIdr: -100 }]),
    (err) => err.code === 'INSTALLMENT_BAD_AMOUNT' && err.status === 400,
  );
});

test('normaliseSchedule: defaults missing fields', () => {
  const r = normaliseSchedule([{ dueDate: '2026-06-01', amountIdr: 5000000 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'PENDING'); // default
  assert.ok(r[0].id); // auto-generated
  assert.equal(r[0].paidAt, undefined); // no paidAt on PENDING
});

test('normaliseSchedule: PAID entries get paidAt timestamp', () => {
  const r = normaliseSchedule([{ dueDate: '2026-06-01', amountIdr: 5000000, status: 'PAID' }]);
  assert.equal(r[0].status, 'PAID');
  assert.ok(r[0].paidAt);
});

test('normaliseSchedule: sorts by dueDate asc', () => {
  const r = normaliseSchedule([
    { dueDate: '2026-08-01', amountIdr: 5000000 },
    { dueDate: '2026-06-01', amountIdr: 5000000 },
    { dueDate: '2026-07-01', amountIdr: 5000000 },
  ]);
  assert.equal(r[0].dueDate, '2026-06-01');
  assert.equal(r[1].dueDate, '2026-07-01');
  assert.equal(r[2].dueDate, '2026-08-01');
});

test('normaliseSchedule: dedupes colliding ids', () => {
  const r = normaliseSchedule([
    { id: 'same', dueDate: '2026-06-01', amountIdr: 1000000 },
    { id: 'same', dueDate: '2026-07-01', amountIdr: 1000000 },
  ]);
  assert.notEqual(r[0].id, r[1].id);
});

test('normaliseSchedule: amounts rounded to integer Rupiah', () => {
  const r = normaliseSchedule([{ dueDate: '2026-06-01', amountIdr: 5000000.7 }]);
  assert.equal(r[0].amountIdr, 5000001);
});

// ── summariseSchedule ───────────────────────────────────────────

test('summariseSchedule: null schedule → null', () => {
  assert.equal(summariseSchedule(null), null);
  assert.equal(summariseSchedule([]), null);
});

test('summariseSchedule: counts + totals + nextDue', () => {
  const s = summariseSchedule([
    { dueDate: '2026-06-01', amountIdr: 5000000, status: 'PAID' },
    { dueDate: '2026-07-01', amountIdr: 5000000, status: 'PENDING' },
    { dueDate: '2026-08-01', amountIdr: 5000000, status: 'PENDING' },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.paidCount, 1);
  assert.equal(s.pendingCount, 2);
  assert.equal(s.paidIdr, 5000000);
  assert.equal(s.pendingIdr, 10000000);
  assert.equal(s.totalIdr, 15000000);
  assert.equal(s.nextDue, '2026-07-01');
  assert.equal(s.nextDueAmount, 5000000);
});

test('summariseSchedule: overdueCount counts PENDING with dueDate < today', () => {
  const now = new Date('2026-06-15T12:00:00');
  const s = summariseSchedule([
    { dueDate: '2026-05-01', amountIdr: 1000000, status: 'PENDING' }, // overdue
    { dueDate: '2026-06-01', amountIdr: 1000000, status: 'PENDING' }, // overdue
    { dueDate: '2026-06-20', amountIdr: 1000000, status: 'PENDING' }, // future
    { dueDate: '2026-04-01', amountIdr: 1000000, status: 'PAID' }, // PAID, not overdue
  ], { now });
  assert.equal(s.overdueCount, 2);
});

// ── applyPaymentToSchedule (S269) ───────────────────────────────

test('applyPaymentToSchedule: marks first PENDING entry PAID when amount covers it', () => {
  const s = [
    { id: '1', dueDate: '2026-06-01', amountIdr: 5000000, status: 'PENDING' },
    { id: '2', dueDate: '2026-07-01', amountIdr: 5000000, status: 'PENDING' },
  ];
  const r = applyPaymentToSchedule(s, 5000000);
  assert.equal(r.changed, true);
  assert.equal(r.schedule[0].status, 'PAID');
  assert.equal(r.schedule[1].status, 'PENDING');
  assert.ok(r.schedule[0].paidAt);
});

test('applyPaymentToSchedule: covers multiple installments when amount is large', () => {
  const s = [
    { id: '1', dueDate: '2026-06-01', amountIdr: 3000000, status: 'PENDING' },
    { id: '2', dueDate: '2026-07-01', amountIdr: 3000000, status: 'PENDING' },
    { id: '3', dueDate: '2026-08-01', amountIdr: 3000000, status: 'PENDING' },
  ];
  const r = applyPaymentToSchedule(s, 7000000); // covers #1 + #2, leftover 1M
  assert.equal(r.changed, true);
  assert.equal(r.schedule[0].status, 'PAID');
  assert.equal(r.schedule[1].status, 'PAID');
  // #3 untouched — partial payment doesn't split entries
  assert.equal(r.schedule[2].status, 'PENDING');
});

test('applyPaymentToSchedule: leaves entry PENDING when amount falls short', () => {
  const s = [
    { id: '1', dueDate: '2026-06-01', amountIdr: 5000000, status: 'PENDING' },
  ];
  const r = applyPaymentToSchedule(s, 3000000); // not enough for #1
  assert.equal(r.changed, false);
  assert.equal(r.schedule[0].status, 'PENDING');
});

test('applyPaymentToSchedule: skips already-PAID entries', () => {
  const s = [
    { id: '1', dueDate: '2026-06-01', amountIdr: 3000000, status: 'PAID', paidAt: '2026-05-30T00:00:00.000Z' },
    { id: '2', dueDate: '2026-07-01', amountIdr: 3000000, status: 'PENDING' },
  ];
  const r = applyPaymentToSchedule(s, 3000000);
  assert.equal(r.schedule[0].status, 'PAID');
  assert.equal(r.schedule[0].paidAt, '2026-05-30T00:00:00.000Z'); // original timestamp preserved
  assert.equal(r.schedule[1].status, 'PAID'); // newly marked
});

test('applyPaymentToSchedule: null/empty schedule → no-op', () => {
  assert.deepEqual(applyPaymentToSchedule(null, 5000000), { changed: false, schedule: null });
  assert.deepEqual(applyPaymentToSchedule([], 5000000), { changed: false, schedule: [] });
});

test('applyPaymentToSchedule: zero/negative amount → no-op', () => {
  const s = [{ id: '1', dueDate: '2026-06-01', amountIdr: 5000000, status: 'PENDING' }];
  assert.equal(applyPaymentToSchedule(s, 0).changed, false);
  assert.equal(applyPaymentToSchedule(s, -100).changed, false);
});

// ── setBookingInstallmentSchedule (DB integration) ──────────────

test('setBookingInstallmentSchedule: 404 on unknown booking', async () => {
  await assert.rejects(
    () => setBookingInstallmentSchedule({
      req: fakeReq, actor: adminActor,
      bookingId: 'cknotexist',
      schedule: [{ dueDate: '2026-06-01', amountIdr: 5000000 }],
    }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('setBookingInstallmentSchedule: refuses on CANCELLED', async (t) => {
  const paket = await tempPaket(t, 'isch-cxl');
  const jemaah = await tempJemaah(t, 'isch-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => setBookingInstallmentSchedule({
      req: fakeReq, actor: adminActor,
      bookingId: b.id,
      schedule: [{ dueDate: '2026-06-01', amountIdr: 5000000 }],
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('setBookingInstallmentSchedule: persists + reads back as JSON', async (t) => {
  const paket = await tempPaket(t, 'isch-set');
  const jemaah = await tempJemaah(t, 'isch-set');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r = await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor,
    bookingId: b.id,
    schedule: [
      { dueDate: '2026-06-01', amountIdr: 5000000 },
      { dueDate: '2026-07-01', amountIdr: 5000000 },
    ],
  });
  assert.equal(r.updated, true);
  assert.equal(r.schedule.length, 2);
  const after = await db.booking.findUnique({
    where: { id: b.id }, select: { installmentSchedule: true },
  });
  assert.ok(Array.isArray(after.installmentSchedule));
  assert.equal(after.installmentSchedule.length, 2);
  assert.equal(after.installmentSchedule[0].dueDate, '2026-06-01');
});

test('setBookingInstallmentSchedule: empty array clears + skip-audit-on-no-op', async (t) => {
  const paket = await tempPaket(t, 'isch-clr');
  const jemaah = await tempJemaah(t, 'isch-clr');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor,
    bookingId: b.id,
    schedule: [{ dueDate: '2026-06-01', amountIdr: 5000000 }],
  });
  const cleared = await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, schedule: [],
  });
  assert.equal(cleared.updated, true);
  assert.equal(cleared.schedule, null);
  // Re-clear is no-op (no audit pollution)
  const noop = await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, schedule: null,
  });
  assert.equal(noop.updated, false);
});

// ── Stage 271 — suggestInstallmentPlan ──────────────────────────

async function setPaketDepartureMs(paket, msFromNow) {
  const d = new Date(Date.now() + msFromNow);
  await db.paket.update({
    where: { id: paket.id }, data: { departureDate: d, returnDate: d },
  });
}

test('suggestInstallmentPlan: 404 on unknown booking', async () => {
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: 'cknotexist' }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('suggestInstallmentPlan: refuses on CANCELLED', async (t) => {
  const paket = await tempPaket(t, 'sip-cxl');
  const jemaah = await tempJemaah(t, 'sip-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('suggestInstallmentPlan: refuses when balance is zero', async (t) => {
  const paket = await tempPaket(t, 'sip-zero');
  const jemaah = await tempJemaah(t, 'sip-zero');
  await setPaketDepartureMs(paket, 90 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({ where: { id: b.id }, data: { paidAmount: '5000000' } });
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id }),
    (err) => err.code === 'BALANCE_ZERO' && err.status === 409,
  );
});

test('suggestInstallmentPlan: refuses when departure is past/unset', async (t) => {
  const paket = await tempPaket(t, 'sip-past');
  const jemaah = await tempJemaah(t, 'sip-past');
  await setPaketDepartureMs(paket, -7 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id }),
    (err) => err.code === 'DEPARTURE_PAST' && err.status === 409,
  );
});

test('suggestInstallmentPlan: refuses when departure is too close (no time)', async (t) => {
  const paket = await tempPaket(t, 'sip-close');
  const jemaah = await tempJemaah(t, 'sip-close');
  // 10 days out — lastDue = departure - 30d, which is in the past
  await setPaketDepartureMs(paket, 10 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id }),
    (err) => err.code === 'NO_TIME' && err.status === 409,
  );
});

test('suggestInstallmentPlan: refuses bad count (0, negative, >24)', async (t) => {
  const paket = await tempPaket(t, 'sip-cnt');
  const jemaah = await tempJemaah(t, 'sip-cnt');
  await setPaketDepartureMs(paket, 200 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id, count: 0 }),
    (err) => err.code === 'BAD_COUNT',
  );
  await assert.rejects(
    () => suggestInstallmentPlan({ bookingId: b.id, count: 25 }),
    (err) => err.code === 'BAD_COUNT',
  );
});

test('suggestInstallmentPlan: returns N entries with sum = remaining balance', async (t) => {
  const paket = await tempPaket(t, 'sip-sum');
  const jemaah = await tempJemaah(t, 'sip-sum');
  await setPaketDepartureMs(paket, 200 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  await db.booking.update({ where: { id: b.id }, data: { paidAmount: '1000000' } });
  // Remaining = 9,000,000
  const r = await suggestInstallmentPlan({ bookingId: b.id, count: 3 });
  assert.equal(r.length, 3);
  const sum = r.reduce((acc, i) => acc + i.amountIdr, 0);
  assert.equal(sum, 9000000);
});

test('suggestInstallmentPlan: handles rounding via tail-cents convention', async (t) => {
  const paket = await tempPaket(t, 'sip-rnd');
  const jemaah = await tempJemaah(t, 'sip-rnd');
  await setPaketDepartureMs(paket, 200 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000001' });
  // Remaining = 10,000,001 with N=3 → 3,333,333 × 2 + 3,333,335 (last has the tail)
  const r = await suggestInstallmentPlan({ bookingId: b.id, count: 3 });
  assert.equal(r.length, 3);
  assert.equal(r[0].amountIdr, 3333333);
  assert.equal(r[1].amountIdr, 3333333);
  assert.equal(r[2].amountIdr, 3333335);
  // Sum must equal remaining (the rounding contract)
  const sum = r.reduce((acc, i) => acc + i.amountIdr, 0);
  assert.equal(sum, 10000001);
});

test('suggestInstallmentPlan: N=1 collapses to single installment on lastDue', async (t) => {
  const paket = await tempPaket(t, 'sip-one');
  const jemaah = await tempJemaah(t, 'sip-one');
  await setPaketDepartureMs(paket, 200 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const r = await suggestInstallmentPlan({ bookingId: b.id, count: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].amountIdr, 10000000);
});

test('suggestInstallmentPlan: returned plan passes normaliseSchedule round-trip', async (t) => {
  const paket = await tempPaket(t, 'sip-rt');
  const jemaah = await tempJemaah(t, 'sip-rt');
  await setPaketDepartureMs(paket, 200 * 24 * 60 * 60_000);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const proposed = await suggestInstallmentPlan({ bookingId: b.id, count: 5 });
  // Must round-trip through normalise without error
  const r = normaliseSchedule(proposed);
  assert.equal(r.length, 5);
  for (const e of r) {
    assert.match(e.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.amountIdr > 0);
    assert.equal(e.status, 'PENDING');
  }
});
