// Smoke test for 5qq — admin PaymentIntent viewer + cancel.
//
// Covers:
//   1. listIntentsForBooking returns rows newest-first (createdAt desc)
//   2. cancelStuckIntent allowed on CREATED / PENDING, marks status=CANCELLED
//   3. cancelStuckIntent refused (409) on SETTLED / CANCELLED / FAILED
//   4. SETTLED intent's paymentId is preserved (no Payment side-effects)
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
  listIntentsForBooking, cancelStuckIntent,
} from '../src/services/paymentGateway.js';

const tag = `smoke5qq-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function makeFixture() {
  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Smoke 5qq', phone: '+628111111111',
      jemaah: { create: { fullName: 'Smoke 5qq', phone: '+628111111111', email: `${tag}@example.test` } },
    },
    include: { jemaah: true },
  });
  const departure = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `smoke-5qq-${tag}`, title: 'Smoke Paket 5qq',
      departureDate: departure, returnDate: new Date(departure.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  return { user, paket, booking };
}

async function main() {
  console.log(`\n[5qq smoke] tag=${tag}`);
  const { user, paket, booking } = await makeFixture();
  const ctx = { req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null } };

  // Create 3 intents to give listIntentsForBooking something to order:
  //  A: 200k → settle it
  //  B: 300k → leave CREATED (stuck)
  //  C: 400k → take through PENDING then leave there
  const intentA = await createPaymentIntent({ ...ctx, bookingId: booking.id, amount: 200_000 });
  // Settle A
  const settleA = buildFakeWebhookPayload({ orderId: intentA.orderId, amount: 200_000, transaction_status: 'settlement' });
  const rA = await handleMidtransNotification({ req: ctx.req, payload: settleA });
  assert(rA.action === 'SETTLED' && rA.payment, 'intent A settled + payment created');

  // Need to leave the first one as the *initial* test — the active-intent guard means
  // we can only create a second intent after the first is terminal. A is SETTLED → terminal, OK.
  const intentB = await createPaymentIntent({ ...ctx, bookingId: booking.id, amount: 300_000 });
  assert(intentB.status === 'CREATED', 'intent B CREATED (still active)');

  // Cancel B via admin path
  const cancelledB = await cancelStuckIntent({ ...ctx, intentId: intentB.id, reason: 'snap session dead' });
  assert(cancelledB.status === 'CANCELLED', 'cancelStuckIntent moves CREATED → CANCELLED');

  // Now we can create C (B is terminal CANCELLED, A is terminal SETTLED)
  const intentC = await createPaymentIntent({ ...ctx, bookingId: booking.id, amount: 400_000 });
  // Push C to PENDING via webhook
  const pendingC = buildFakeWebhookPayload({ orderId: intentC.orderId, amount: 400_000, transaction_status: 'pending' });
  const rC = await handleMidtransNotification({ req: ctx.req, payload: pendingC });
  assert(rC.intent.status === 'PENDING', 'intent C transitioned to PENDING');

  // Cancel C while PENDING
  const cancelledC = await cancelStuckIntent({ ...ctx, intentId: intentC.id, reason: 'user changed mind' });
  assert(cancelledC.status === 'CANCELLED', 'cancelStuckIntent works on PENDING too');

  // 1. listIntentsForBooking: newest-first ordering, count=3
  const list = await listIntentsForBooking(booking.id);
  assert(list.length === 3, 'list returns all 3 intents');
  // C was created last (after B cancelled) → first in newest-first order
  assert(list[0].id === intentC.id, 'newest first (C)');
  assert(list[1].id === intentB.id, 'middle (B)');
  assert(list[2].id === intentA.id, 'oldest last (A)');
  // SETTLED intent A retains paymentId
  assert(list[2].paymentId, 'SETTLED intent preserves paymentId reference');

  // 3. Refuse cancel on terminal statuses
  let settledBlocked = false;
  try { await cancelStuckIntent({ ...ctx, intentId: intentA.id, reason: 'oops' }); }
  catch (e) { settledBlocked = e.code === 'INTENT_NOT_CANCELLABLE'; }
  assert(settledBlocked, 'cancelStuckIntent refuses SETTLED (409)');

  let cancelledBlocked = false;
  try { await cancelStuckIntent({ ...ctx, intentId: intentB.id, reason: 'twice' }); }
  catch (e) { cancelledBlocked = e.code === 'INTENT_NOT_CANCELLABLE'; }
  assert(cancelledBlocked, 'cancelStuckIntent refuses already-CANCELLED (409)');

  // 4. Verify SETTLED intent's payment row was NOT touched by intent cancel attempts
  const paymentStillThere = await db.payment.findUnique({ where: { id: list[2].paymentId } });
  assert(paymentStillThere && paymentStillThere.status === 'PAID', 'SETTLED Payment untouched');

  // Cleanup
  await db.paymentIntent.deleteMany({ where: { bookingId: booking.id } });
  await db.payment.deleteMany({ where: { bookingId: booking.id } });
  await db.komisi.deleteMany({ where: { bookingId: booking.id } });
  await db.booking.delete({ where: { id: booking.id } });
  await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.delete({ where: { id: user.jemaah.id } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: [user.email, 'sys@test', 'midtrans-webhook'] } } });
  await db.user.delete({ where: { id: user.id } });
  console.log('  cleanup done');

  console.log('\n[5qq smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5qq smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
