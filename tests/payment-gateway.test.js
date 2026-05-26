// Integration tests for the Midtrans payment gateway (5pp + 5qq + 5xx + 5yy).
// Runs against the dev MariaDB. Uses fake mode (no MIDTRANS_SERVER_KEY).
//
// Each top-level test gets a unique tag + registers its own cleanup via t.after.
// Tests share the dev DB but are isolated by tag — never assert on global counts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, fakeReq, systemActor } from './_helpers.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
  listIntentsForBooking, cancelStuckIntent, getActiveIntentForJemaahBooking,
  listPaymentIntents, PAYMENT_INTENT_STATUSES,
} from '../src/services/paymentGateway.js';
import { isMidtransFakeMode } from '../src/lib/midtrans.js';
import { expireStaleIntents } from '../src/services/expireIntents.js';

const ctx = (actor = systemActor) => ({ req: fakeReq, actor });

describe('payment gateway — fake mode prerequisite', () => {
  test('runner is in fake mode (no MIDTRANS_SERVER_KEY)', () => {
    assert.equal(isMidtransFakeMode(), true,
      'integration tests require MIDTRANS_SERVER_KEY to be unset');
  });
});

describe('createPaymentIntent', () => {
  test('fake-mode intent has deterministic snap token + redirect URL', async (t) => {
    const tag = makeTag('5pp-create');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    const intent = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 400_000 });
    assert.match(intent.orderId, /^PI-/, 'orderId is PI-<intentId>');
    assert.equal(intent.snapToken, `fake-snap-${intent.orderId}`, 'deterministic fake token');
    assert.match(intent.snapRedirectUrl, /\/payments\/midtrans\/fake/, 'fake redirect URL');
    assert.equal(intent.status, 'CREATED', 'starts CREATED');
  });

  test('amount > remaining rejected', async (t) => {
    const tag = makeTag('5pp-overflow');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    await assert.rejects(
      createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 5_000_000 }),
      (err) => err.code === 'AMOUNT_EXCEEDS_REMAINING',
    );
  });

  test('active intent guard blocks second; replaceActive bypasses', async (t) => {
    const tag = makeTag('5pp-active');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 500_000 });
    await assert.rejects(
      createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 500_000 }),
      (err) => err.code === 'INTENT_ALREADY_ACTIVE',
    );

    const replaced = await createPaymentIntent({
      ...ctx(), bookingId: booking.id, amount: 500_000, replaceActive: true,
    });
    assert.equal(replaced.status, 'CREATED');

    const active = await db.paymentIntent.count({
      where: { bookingId: booking.id, status: { in: ['CREATED', 'PENDING'] } },
    });
    assert.equal(active, 1, 'exactly 1 active intent after replace');
  });
});

describe('handleMidtransNotification', () => {
  test('settlement materialises Payment via recordPayment + transitions booking', async (t) => {
    const tag = makeTag('5pp-settle');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    const intent = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 400_000 });
    const payload = buildFakeWebhookPayload({
      orderId: intent.orderId, amount: 400_000, transaction_status: 'settlement',
    });
    const r = await handleMidtransNotification({ req: fakeReq, payload });
    assert.equal(r.action, 'SETTLED');
    assert.ok(r.payment, 'Payment row created');
    assert.match(r.payment.gatewayRef, /^FAKE-TX-/);

    const bk = await db.booking.findUnique({
      where: { id: booking.id }, select: { status: true, paidAmount: true },
    });
    assert.equal(Number(bk.paidAmount.toString()), 400_000);
    assert.equal(bk.status, 'DP_PAID');
  });

  test('duplicate settlement webhook is NOOP (no double-credit)', async (t) => {
    const tag = makeTag('5pp-dupe');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    const intent = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 200_000 });
    const payload = buildFakeWebhookPayload({
      orderId: intent.orderId, amount: 200_000, transaction_status: 'settlement',
    });
    await handleMidtransNotification({ req: fakeReq, payload });
    const r2 = await handleMidtransNotification({ req: fakeReq, payload });
    assert.equal(r2.action, 'NOOP');

    const payCount = await db.payment.count({ where: { bookingId: booking.id } });
    assert.equal(payCount, 1, 'still only 1 Payment row');
  });

  test('pending → settlement transitions through PENDING first', async (t) => {
    const tag = makeTag('5pp-pending');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    const intent = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 300_000 });
    const pending = buildFakeWebhookPayload({
      orderId: intent.orderId, amount: 300_000, transaction_status: 'pending',
    });
    const rPending = await handleMidtransNotification({ req: fakeReq, payload: pending });
    assert.equal(rPending.action, 'STATUS_UPDATED');
    assert.equal(rPending.intent.status, 'PENDING');

    const settled = buildFakeWebhookPayload({
      orderId: intent.orderId, amount: 300_000, transaction_status: 'settlement',
    });
    const rSettled = await handleMidtransNotification({ req: fakeReq, payload: settled });
    assert.equal(rSettled.action, 'SETTLED');
  });
});

describe('listIntentsForBooking + cancelStuckIntent (5qq)', () => {
  test('list newest-first; cancel works on CREATED + PENDING; refuses terminal', async (t) => {
    const tag = makeTag('5qq');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    // Settle one to seed a SETTLED intent
    const i1 = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 100_000 });
    await handleMidtransNotification({
      req: fakeReq,
      payload: buildFakeWebhookPayload({ orderId: i1.orderId, amount: 100_000, transaction_status: 'settlement' }),
    });

    // Now create another, leave CREATED
    const i2 = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 200_000 });

    const list = await listIntentsForBooking(booking.id);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, i2.id, 'newest first (CREATED is more recent)');
    assert.equal(list[1].id, i1.id);
    assert.ok(list[1].paymentId, 'SETTLED intent retains paymentId');

    // Cancel works on CREATED
    const cancelled = await cancelStuckIntent({ ...ctx(), intentId: i2.id, reason: 'snap session dead' });
    assert.equal(cancelled.status, 'CANCELLED');

    // Refuses on terminal SETTLED
    await assert.rejects(
      cancelStuckIntent({ ...ctx(), intentId: i1.id, reason: 'oops' }),
      (err) => err.code === 'INTENT_NOT_CANCELLABLE',
    );
  });
});

describe('getActiveIntentForJemaahBooking (5xx)', () => {
  test('returns latest non-terminal scoped to jemaahUserId, ignores terminal', async (t) => {
    const tag = makeTag('5xx');
    const owner = await tempJemaah(t, tag + '-owner');
    const stranger = await tempJemaah(t, tag + '-other');
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: owner.jemaah.id, jemaahUserId: owner.id });

    assert.equal(
      await getActiveIntentForJemaahBooking({ userId: owner.id, bookingId: booking.id }),
      null,
      'no intent → null',
    );

    // Create CREATED
    const created = await createPaymentIntent({ ...ctx(), bookingId: booking.id, amount: 200_000 });
    const live1 = await getActiveIntentForJemaahBooking({ userId: owner.id, bookingId: booking.id });
    assert.equal(live1?.id, created.id);

    // Other user → null (ownership)
    const otherView = await getActiveIntentForJemaahBooking({
      userId: stranger.id, bookingId: booking.id,
    });
    assert.equal(otherView, null, 'stranger gets null (ownership scope)');

    // Add a newer FAILED — terminal must NOT be returned
    await db.paymentIntent.create({
      data: {
        bookingId: booking.id, provider: 'MIDTRANS',
        orderId: `PI-${tag}-failed`,
        amount: '100000', currency: 'IDR',
        status: 'FAILED',
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    const live2 = await getActiveIntentForJemaahBooking({ userId: owner.id, bookingId: booking.id });
    assert.equal(live2?.id, created.id, 'newer FAILED ignored, still returns CREATED');
  });
});

describe('listPaymentIntents (5tt)', () => {
  test('countsByStatus spans all statuses; search matches orderId AND bookingNo', async (t) => {
    const tag = makeTag('5tt');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const bookingA = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    const bookingB = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    // Stagger createdAt so newest-first ordering is predictable within scope
    async function mk(suffix, bookingId, status, offset) {
      return db.paymentIntent.create({
        data: {
          bookingId, provider: 'MIDTRANS',
          orderId: `PI-${tag}-${suffix}`,
          amount: '100000', currency: 'IDR',
          status,
          createdAt: new Date(Date.now() - (5 - offset) * 1000),
        },
      });
    }
    await mk('a1', bookingA.id, 'SETTLED', 0);
    await mk('a2', bookingA.id, 'CREATED', 1);
    await mk('b1', bookingB.id, 'PENDING', 2);
    await mk('b2', bookingB.id, 'FAILED', 3);
    await mk('b3', bookingB.id, 'CANCELLED', 4);

    // countsByStatus has all 6 keys (zero-filled for absent)
    const all = await listPaymentIntents({});
    for (const s of PAYMENT_INTENT_STATUSES) {
      assert.equal(typeof all.countsByStatus[s], 'number', `countsByStatus.${s} present`);
    }

    // Search by orderId substring (tag is unique enough to scope to our rows)
    const byOrderId = await listPaymentIntents({ search: `PI-${tag}-b1` });
    assert.ok(byOrderId.rows.some((r) => r.orderId === `PI-${tag}-b1`));

    // Search by bookingNo substring (cross-table OR via Prisma relation filter)
    const byBookingNo = await listPaymentIntents({ search: bookingA.bookingNo });
    const aHits = byBookingNo.rows.filter((r) => r.booking?.bookingNo === bookingA.bookingNo);
    assert.equal(aHits.length, 2, 'matches both intents on bookingA');

    // Status filter narrows rows; countsByStatus still spans all (invariant)
    const onlyFailed = await listPaymentIntents({ status: 'FAILED' });
    assert.ok(onlyFailed.rows.every((r) => r.status === 'FAILED'));
    for (const s of PAYMENT_INTENT_STATUSES) {
      assert.equal(typeof onlyFailed.countsByStatus[s], 'number',
        `${s} count still computed under status filter`);
    }

    // Pagination math
    assert.equal(all.pageSize, 50);
    assert.equal(all.totalPages, Math.max(1, Math.ceil(all.total / 50)));
  });
});

describe('expireStaleIntents (5uu)', () => {
  test('stale CREATED/PENDING → EXPIRED; fresh + terminal untouched; idempotent', async (t) => {
    const tag = makeTag('5uu');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    const past = new Date(Date.now() - 60 * 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    async function mkIntent(suffix, status, expiresAt) {
      return db.paymentIntent.create({
        data: {
          bookingId: booking.id, provider: 'MIDTRANS',
          orderId: `PI-${tag}-${suffix}`,
          amount: '100000', currency: 'IDR',
          status, expiresAt,
        },
      });
    }
    const staleC = await mkIntent('sc', 'CREATED', past);
    const staleP = await mkIntent('sp', 'PENDING', past);
    const fresh  = await mkIntent('fr', 'CREATED', future);
    const settled = await mkIntent('s', 'SETTLED', past);
    const cancelled = await mkIntent('cn', 'CANCELLED', past);

    const r = await expireStaleIntents({ actor: { email: 'test-runner' } });
    assert.ok(r.scanned >= 2, 'scanned at least the 2 stale rows');
    assert.equal(r.errors.length, 0);

    const after = await db.paymentIntent.findMany({
      where: { id: { in: [staleC.id, staleP.id, fresh.id, settled.id, cancelled.id] } },
      select: { id: true, status: true },
    });
    const byId = Object.fromEntries(after.map((r) => [r.id, r.status]));
    assert.equal(byId[staleC.id], 'EXPIRED', 'stale CREATED → EXPIRED');
    assert.equal(byId[staleP.id], 'EXPIRED', 'stale PENDING → EXPIRED');
    assert.equal(byId[fresh.id], 'CREATED', 'fresh CREATED untouched');
    assert.equal(byId[settled.id], 'SETTLED', 'terminal SETTLED untouched');
    assert.equal(byId[cancelled.id], 'CANCELLED', 'terminal CANCELLED untouched');

    // Idempotent: re-run does NOT re-touch our staleC (already EXPIRED)
    const r2 = await expireStaleIntents({ actor: { email: 'test-runner' } });
    const staleAfter2 = await db.paymentIntent.findUnique({ where: { id: staleC.id } });
    assert.equal(staleAfter2.status, 'EXPIRED');
    assert.equal(typeof r2.expired, 'number');

    // Audit row stamped
    const audits = await db.auditLog.findMany({
      where: { entity: 'PaymentIntent', entityId: staleC.id, action: 'STATUS_CHANGE' },
      select: { actorEmail: true, after: true },
    });
    t.after(() => db.auditLog.deleteMany({
      where: { entity: 'PaymentIntent', entityId: { in: [staleC.id, staleP.id] } },
    }));
    assert.ok(audits.length > 0, 'audit row written');
    assert.equal(audits[0].actorEmail, 'test-runner');
    assert.equal(audits[0].after.autoExpired, true);
  });
});
