// Stage 238 — sanitized jemaah-side activity timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getJemaahBookingActivity } from '../src/services/jemaahBookingActivity.js';
import { audit } from '../src/lib/audit.js';

const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('getJemaahBookingActivity: returns empty shape on missing booking', async () => {
  const r = await getJemaahBookingActivity('does-not-exist');
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
});

test('getJemaahBookingActivity: includes PAID payment rows with humanised label', async (t) => {
  const tag = makeTag('s238-paid');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '500000', currency: 'IDR',
      method: 'TRANSFER', status: 'PAID',
      paidAt: new Date(),
    },
  });
  t.after(async () => { await db.payment.deleteMany({ where: { bookingId: b.id } }); });

  const r = await getJemaahBookingActivity(b.id);
  const paidRow = r.rows.find((row) => row.kind === 'payment');
  assert.ok(paidRow);
  assert.match(paidRow.label, /500\.000/);
  assert.match(paidRow.label, /TRANSFER/);
  assert.equal(paidRow.badge, 'PAID');
});

test('getJemaahBookingActivity: REFUND_ISSUED audit row surfaces with structured reason label', async (t) => {
  const tag = makeTag('s238-refund');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // Seed a synthetic REFUND_ISSUED audit row
  await audit({
    req: fakeReq, actor: { id: null, email: 'admin@x', role: 'OWNER' },
    action: 'REFUND_ISSUED', entity: 'Booking', entityId: b.id,
    before: { status: 'CANCELLED' },
    after: {
      status: 'CANCELLED', refundAmount: 500_000,
      refundReasonCode: 'GOODWILL',
      paymentId: 'x',
    },
  });

  const r = await getJemaahBookingActivity(b.id);
  const refundRow = r.rows.find((row) => row.kind === 'refund');
  assert.ok(refundRow);
  // Structured reason label visible
  assert.match(refundRow.label, /goodwill/i);
  assert.equal(refundRow.badge, 'REFUND');
});

test('getJemaahBookingActivity: surfaces VERIFIED docs as emerald', async (t) => {
  const tag = makeTag('s238-doc');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.jemaahDocument.create({
    data: {
      jemaahId: u.jemaah.id, type: 'PASSPORT', status: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await getJemaahBookingActivity(b.id);
  const docRow = r.rows.find((row) => row.kind === 'doc');
  assert.ok(docRow);
  assert.match(docRow.label, /Paspor terverifikasi/);
  assert.equal(docRow.badge, 'VERIFIED');
});

test('getJemaahBookingActivity: REJECTED doc surfaces with call-to-action', async (t) => {
  const tag = makeTag('s238-rejected');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'VISA_UMROH', status: 'REJECTED' },
  });
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await getJemaahBookingActivity(b.id);
  const docRow = r.rows.find((row) => row.kind === 'doc' && row.badge === 'REJECTED');
  assert.ok(docRow);
  assert.match(docRow.label, /Visa Umroh ditolak/);
  assert.match(docRow.label, /upload ulang/);
});

test('getJemaahBookingActivity: NO admin emails or internal note content leaked', async (t) => {
  const tag = makeTag('s238-sanitize');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // Seed an audit row with admin email + private internal note
  await audit({
    req: fakeReq, actor: { id: null, email: 'sekretaris@religio.pro', role: 'OWNER' },
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: b.id,
    before: { status: 'PENDING' },
    after: { status: 'BOOKED', internalNote: 'Jemaah diragukan — cek dulu' },
  });

  const r = await getJemaahBookingActivity(b.id);
  for (const row of r.rows) {
    assert.ok(!JSON.stringify(row).includes('sekretaris@religio.pro'), 'no admin email leaked');
    assert.ok(!JSON.stringify(row).includes('diragukan'), 'no internal note leaked');
  }
});

test('getJemaahBookingActivity: pickup choice surfaces without actor info', async (t) => {
  const tag = makeTag('s238-pickup');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: b.id,
    before: { pickupId: null },
    after: { pickupId: 'p1', pickupLabel: 'Bekasi', pickupChosen: true },
  });

  const r = await getJemaahBookingActivity(b.id);
  const pickupRow = r.rows.find((row) => row.kind === 'pickup');
  assert.ok(pickupRow);
  assert.match(pickupRow.label, /pickup/i);
});

test('getJemaahBookingActivity: tag changes NOT surfaced (internal labelling)', async (t) => {
  const tag = makeTag('s238-tags');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await audit({
    req: fakeReq, actor: { id: null, email: 'admin@x', role: 'OWNER' },
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: b.id,
    before: { tags: [] },
    after: { tags: ['VIP'], tagsChanged: true },
  });

  const r = await getJemaahBookingActivity(b.id);
  // Tag change audit rows shouldn't surface to jemaah
  const tagRow = r.rows.find((row) => JSON.stringify(row).includes('VIP'));
  assert.equal(tagRow, undefined);
});

test('getJemaahBookingActivity: sorted newest-first', async (t) => {
  const tag = makeTag('s238-order');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // Payment created later than booking creation
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '100000', currency: 'IDR',
      method: 'CASH', status: 'PAID',
      paidAt: new Date(),
    },
  });
  t.after(async () => { await db.payment.deleteMany({ where: { bookingId: b.id } }); });

  const r = await getJemaahBookingActivity(b.id);
  for (let i = 1; i < r.rows.length; i += 1) {
    const prev = new Date(r.rows[i - 1].when).getTime();
    const cur = new Date(r.rows[i].when).getTime();
    assert.ok(prev >= cur, `row ${i} should be older than row ${i-1}`);
  }
});
