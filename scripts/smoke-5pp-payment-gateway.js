// Smoke test for 5pp — Midtrans payment gateway integration.
//
// Runs in fake mode (no MIDTRANS_SERVER_KEY in .env). Covers:
//   1. createPaymentIntent registers a row with synthetic snap token + fake URL
//   2. Webhook signature verifier accepts valid signature, rejects bad ones
//   3. handleMidtransNotification on 'settlement' materializes a Payment via
//      recordPayment (booking.paidAmount + status transition both happen)
//   4. Duplicate SETTLED webhook is idempotent (no second Payment)
//   5. PENDING-then-SETTLED works (status updates in between)
//   6. Amount > remaining is rejected
//   7. Second intent on a booking with active intent is rejected unless replaceActive
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
} from '../src/services/paymentGateway.js';
import { verifyMidtransSignature, isMidtransFakeMode } from '../src/lib/midtrans.js';

const tag = `smoke5pp-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function makeFixture() {
  // Need a real Paket + Booking — recordPayment validates booking + paket linkage
  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Smoke 5pp', phone: '+628111111111',
      jemaah: { create: { fullName: 'Smoke 5pp', phone: '+628111111111', email: `${tag}@example.test` } },
    },
    include: { jemaah: true },
  });
  const departure = new Date(Date.now() + 30 * 86_400_000);
  const ret = new Date(Date.now() + 40 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `smoke-5pp-${tag}`, title: 'Smoke Paket 5pp',
      departureDate: departure, returnDate: ret, durationDays: 10,
      inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0,
      status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
      jemaahUserId: user.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0',
      status: 'PENDING',
    },
  });
  return { user, paket, booking };
}

async function main() {
  console.log(`\n[5pp smoke] tag=${tag} fakeMode=${isMidtransFakeMode()}`);
  if (!isMidtransFakeMode()) {
    console.error('FAIL: smoke requires fake mode (clear MIDTRANS_SERVER_KEY)');
    process.exit(1);
  }

  const { user, paket, booking } = await makeFixture();
  const actor = { id: user.id, email: user.email, role: user.role };

  // 1. Create intent for partial amount (400k of 1M)
  const intent1 = await createPaymentIntent({
    req: { ip: '127.0.0.1', headers: {} }, actor,
    bookingId: booking.id, amount: 400_000,
  });
  assert(intent1.orderId.startsWith('PI-'), 'orderId format PI-<id>');
  assert(intent1.snapToken === `fake-snap-${intent1.orderId}`, 'fake snap token deterministic');
  assert(intent1.snapRedirectUrl.includes('/payments/midtrans/fake'), 'fake redirect URL points to local handler');
  assert(intent1.status === 'CREATED', 'intent starts CREATED');

  // 2. Signature verification
  const goodPayload = buildFakeWebhookPayload({
    orderId: intent1.orderId, amount: 400_000, transaction_status: 'settlement',
  });
  assert(verifyMidtransSignature(goodPayload), 'valid signature accepted');
  assert(!verifyMidtransSignature({ ...goodPayload, signature_key: 'a'.repeat(128) }), 'wrong signature rejected');
  assert(!verifyMidtransSignature({}), 'missing fields rejected');

  // 3. Settlement webhook → Payment materialized, booking transitions to DP_PAID
  const r1 = await handleMidtransNotification({ req: { ip: '127.0.0.1', headers: {} }, payload: goodPayload });
  assert(r1.action === 'SETTLED', 'first settlement returns SETTLED');
  assert(r1.payment, 'Payment row created');
  assert(r1.payment.gatewayRef.startsWith('FAKE-TX-'), 'gateway ref captured');

  const bk1 = await db.booking.findUnique({ where: { id: booking.id }, select: { status: true, paidAmount: true } });
  assert(Number(bk1.paidAmount.toString()) === 400_000, 'booking.paidAmount = 400k');
  assert(bk1.status === 'DP_PAID', 'booking transitions PENDING → DP_PAID');

  // 4. Duplicate webhook is idempotent
  const r2 = await handleMidtransNotification({ req: { ip: '127.0.0.1', headers: {} }, payload: goodPayload });
  assert(r2.action === 'NOOP', 'duplicate settlement is NOOP');
  const paymentCount = await db.payment.count({ where: { bookingId: booking.id } });
  assert(paymentCount === 1, 'still only 1 Payment row after duplicate webhook');

  // 5. Second intent for remaining 600k
  const intent2 = await createPaymentIntent({
    req: { ip: '127.0.0.1', headers: {} }, actor,
    bookingId: booking.id, amount: 600_000,
  });
  assert(intent2.status === 'CREATED', 'second intent created');

  // PENDING webhook first (e.g. VA pending bank confirm), then SETTLED
  const pendingPayload = buildFakeWebhookPayload({
    orderId: intent2.orderId, amount: 600_000, transaction_status: 'pending',
  });
  const r3 = await handleMidtransNotification({ req: { ip: '127.0.0.1', headers: {} }, payload: pendingPayload });
  assert(r3.action === 'STATUS_UPDATED' && r3.intent.status === 'PENDING', 'pending → STATUS_UPDATED');

  const settlePayload = buildFakeWebhookPayload({
    orderId: intent2.orderId, amount: 600_000, transaction_status: 'settlement',
  });
  const r4 = await handleMidtransNotification({ req: { ip: '127.0.0.1', headers: {} }, payload: settlePayload });
  assert(r4.action === 'SETTLED', 'subsequent settlement materializes');

  const bk2 = await db.booking.findUnique({ where: { id: booking.id }, select: { status: true, paidAmount: true } });
  assert(Number(bk2.paidAmount.toString()) === 1_000_000, 'paidAmount fully paid');
  assert(bk2.status === 'LUNAS', 'booking transitions to LUNAS on full settlement');

  // 6. Amount > remaining rejected
  let overflowRejected = false;
  try {
    await createPaymentIntent({
      req: { ip: '127.0.0.1', headers: {} }, actor,
      bookingId: booking.id, amount: 1,
    });
  } catch (err) {
    // After LUNAS the booking is no longer accepting payments via createPaymentIntent
    // since remaining = 0 → amount > 0 exceeds remaining
    overflowRejected = err.code === 'AMOUNT_EXCEEDS_REMAINING' || err.code === 'BOOKING_CLOSED';
  }
  assert(overflowRejected, 'amount > remaining (or LUNAS booking) refuses new intent');

  // 7. Active-intent guard: create a fresh booking, create intent, second intent without replaceActive → 409
  const booking2 = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  await createPaymentIntent({
    req: { ip: '127.0.0.1', headers: {} }, actor,
    bookingId: booking2.id, amount: 500_000,
  });
  let activeBlocked = false;
  try {
    await createPaymentIntent({
      req: { ip: '127.0.0.1', headers: {} }, actor,
      bookingId: booking2.id, amount: 500_000,
    });
  } catch (err) { activeBlocked = err.code === 'INTENT_ALREADY_ACTIVE'; }
  assert(activeBlocked, '2nd intent without replaceActive blocked');

  // replaceActive=true cancels the prior intent + creates a new one
  const replaced = await createPaymentIntent({
    req: { ip: '127.0.0.1', headers: {} }, actor,
    bookingId: booking2.id, amount: 500_000, replaceActive: true,
  });
  assert(replaced.status === 'CREATED', 'replaceActive creates fresh intent');
  const activeCount = await db.paymentIntent.count({
    where: { bookingId: booking2.id, status: { in: ['CREATED', 'PENDING'] } },
  });
  assert(activeCount === 1, 'exactly 1 active intent after replace');

  // Cleanup
  await db.paymentIntent.deleteMany({ where: { bookingId: { in: [booking.id, booking2.id] } } });
  await db.payment.deleteMany({ where: { bookingId: { in: [booking.id, booking2.id] } } });
  await db.komisi.deleteMany({ where: { bookingId: { in: [booking.id, booking2.id] } } });
  await db.booking.deleteMany({ where: { id: { in: [booking.id, booking2.id] } } });
  await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.delete({ where: { id: user.jemaah.id } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: [user.email, 'midtrans-webhook'] } } });
  await db.user.delete({ where: { id: user.id } });
  console.log('  cleanup done');

  console.log('\n[5pp smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5pp smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
