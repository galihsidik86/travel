// Smoke test for 5tt — global PaymentIntent viewer.
//
// Covers:
//   1. listPaymentIntents returns rows ordered newest-first
//   2. status filter narrows rows + leaves countsByStatus untouched
//   3. search matches by orderId substring
//   4. search matches by booking.bookingNo substring (cross-table OR)
//   5. date range filter on createdAt
//   6. pagination math (totalPages, page slicing)
//   7. countsByStatus covers all 6 statuses with zeros for absent ones
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { listPaymentIntents, PAYMENT_INTENT_STATUSES } from '../src/services/paymentGateway.js';

const tag = `smoke5tt-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log(`\n[5tt smoke] tag=${tag}`);

  // Fixture: 1 user + 1 paket + 2 bookings, then a handful of intents in mixed statuses
  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Smoke 5tt', phone: '+628111111111',
      jemaah: { create: { fullName: 'Smoke 5tt', phone: '+628111111111', email: `${tag}@example.test` } },
    },
    include: { jemaah: true },
  });
  const departure = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `5tt-${tag}`, title: 'Paket 5tt',
      departureDate: departure, returnDate: new Date(departure.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  const bookingA = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: user.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const bookingB = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: user.jemaah.id,
      kelas: 'TRIPLE', paxCount: 1, totalAmount: '500000', paidAmount: '0', status: 'PENDING',
    },
  });

  // Create 5 intents:
  //   A1, A2 → bookingA (one SETTLED, one CREATED)
  //   B1, B2, B3 → bookingB (PENDING, FAILED, CANCELLED)
  // Stagger createdAt so the newest-first order is predictable
  const now = Date.now();
  async function mkIntent(suffix, bookingId, status, opts = {}) {
    return db.paymentIntent.create({
      data: {
        bookingId, provider: 'MIDTRANS',
        orderId: `PI-${tag}-${suffix}`,
        amount: '100000', currency: 'IDR',
        status,
        gatewayStatus: opts.gatewayStatus || null,
        createdAt: opts.createdAt || new Date(now - (5 - opts.offset) * 1000),
      },
    });
  }
  await mkIntent('a1', bookingA.id, 'SETTLED',   { offset: 0, gatewayStatus: 'settlement' });
  await mkIntent('a2', bookingA.id, 'CREATED',   { offset: 1 });
  await mkIntent('b1', bookingB.id, 'PENDING',   { offset: 2, gatewayStatus: 'pending' });
  await mkIntent('b2', bookingB.id, 'FAILED',    { offset: 3, gatewayStatus: 'deny' });
  await mkIntent('b3', bookingB.id, 'CANCELLED', { offset: 4 });

  // 1. Default listing — newest first
  const all = await listPaymentIntents({});
  // total >= 5 (other intents may exist in DB from prior smoke runs leftover)
  // but our 5 should appear first among newest if we ordered by recent createdAt
  // Find OUR intents in the result
  const ours = all.rows.filter((r) => r.orderId.startsWith(`PI-${tag}-`));
  assert(ours.length === 5, 'all 5 of our intents present in listing');
  // Verify our slice is in newest-first order (b3 is most recent in our group)
  const orderedOrderIds = ours.map((r) => r.orderId);
  const expected = ['b3', 'b2', 'b1', 'a2', 'a1'].map((s) => `PI-${tag}-${s}`);
  assert(JSON.stringify(orderedOrderIds) === JSON.stringify(expected), 'newest-first order correct within scope');

  // 7. countsByStatus across ALL statuses (zeros for missing)
  for (const s of PAYMENT_INTENT_STATUSES) {
    assert(typeof all.countsByStatus[s] === 'number', `countsByStatus has key ${s}`);
  }
  // EXPIRED has no rows in our fixture (and unlikely in leftover), so it's 0 OR positive
  // CREATED has at least 1 (a2)
  assert(all.countsByStatus.CREATED >= 1 && all.countsByStatus.SETTLED >= 1, 'CREATED + SETTLED counts include ours');

  // 2. Status filter narrows rows; countsByStatus still spans all statuses
  const onlyFailed = await listPaymentIntents({ status: 'FAILED' });
  assert(onlyFailed.rows.every((r) => r.status === 'FAILED'), 'status=FAILED narrows rows');
  // countsByStatus is computed WITHOUT status filter, so it should still have all 6 keys
  for (const s of PAYMENT_INTENT_STATUSES) {
    assert(typeof onlyFailed.countsByStatus[s] === 'number', `countsByStatus[${s}] still present under status filter`);
  }

  // 3. Search by orderId substring (our tag is unique enough)
  const byOrderId = await listPaymentIntents({ search: `PI-${tag}-b1` });
  const matchOrderId = byOrderId.rows.filter((r) => r.orderId === `PI-${tag}-b1`);
  assert(matchOrderId.length === 1 && byOrderId.rows.every((r) => r.orderId.includes(`${tag}-b1`)),
    'search by orderId substring matches');

  // 4. Search by bookingNo substring (cross-table OR)
  const byBookingNo = await listPaymentIntents({ search: `RP-${tag}-A` });
  const oursInBooking = byBookingNo.rows.filter((r) => r.booking?.bookingNo === bookingA.bookingNo);
  assert(oursInBooking.length === 2, 'search by bookingNo matches both A intents');
  assert(oursInBooking.every((r) => r.booking?.bookingNo === bookingA.bookingNo), 'all hits belong to bookingA');

  // 5. Date range filter
  const veryOld = await listPaymentIntents({ from: '2020-01-01', to: '2020-12-31' });
  const oursInOld = veryOld.rows.filter((r) => r.orderId.startsWith(`PI-${tag}-`));
  assert(oursInOld.length === 0, 'date range that excludes ours → 0 of our rows');

  const today = new Date().toISOString().slice(0, 10);
  const inToday = await listPaymentIntents({ from: today, to: today });
  const oursInToday = inToday.rows.filter((r) => r.orderId.startsWith(`PI-${tag}-`));
  assert(oursInToday.length === 5, 'today range includes all 5 fresh intents');

  // 6. Pagination math — page 1 returns up to pageSize rows; totalPages reflects total
  assert(all.pageSize === 50, 'pageSize = 50');
  assert(all.totalPages === Math.max(1, Math.ceil(all.total / 50)), 'totalPages math correct');

  // Cleanup
  await db.paymentIntent.deleteMany({ where: { bookingId: { in: [bookingA.id, bookingB.id] } } });
  await db.booking.deleteMany({ where: { id: { in: [bookingA.id, bookingB.id] } } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.delete({ where: { id: user.jemaah.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log('  cleanup done');

  console.log('\n[5tt smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5tt smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
