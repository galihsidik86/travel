// Smoke test for 5xx — jemaah intent status polling.
//
// Service-layer covers:
//   1. getActiveIntentForJemaahBooking returns null when no live intent
//   2. Returns null when intent exists but is terminal (SETTLED/EXPIRED/CANCELLED/FAILED)
//   3. Returns CREATED intent
//   4. Returns PENDING intent
//   5. Multi-intent: picks newest CREATED/PENDING, terminal rows ignored
//   6. Ownership scope: wrong user's request returns null
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { getActiveIntentForJemaahBooking } from '../src/services/paymentGateway.js';

const tag = `smoke5xx-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log(`\n[5xx smoke] tag=${tag}`);

  const passwordHash = await hashPassword('smoke12345');
  const ownerUser = await db.user.create({
    data: {
      email: `${tag}-owner@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Owner', phone: '+628111',
      jemaah: { create: { fullName: 'Owner', phone: '+628111' } },
    },
    include: { jemaah: true },
  });
  const otherUser = await db.user.create({
    data: {
      email: `${tag}-other@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Other', phone: '+628222',
      jemaah: { create: { fullName: 'Other', phone: '+628222' } },
    },
    include: { jemaah: true },
  });
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `5xx-${tag}`, title: 'Paket 5xx',
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: ownerUser.jemaah.id,
      jemaahUserId: ownerUser.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });

  // 1. No intents → null
  let live = await getActiveIntentForJemaahBooking({ userId: ownerUser.id, bookingId: booking.id });
  assert(live === null, 'no intent → null');

  // 2. Terminal intent only → null
  await db.paymentIntent.create({
    data: {
      bookingId: booking.id, provider: 'MIDTRANS',
      orderId: `PI-${tag}-set`,
      amount: '100000', currency: 'IDR',
      status: 'SETTLED',
      createdAt: new Date(Date.now() - 60_000),
    },
  });
  live = await getActiveIntentForJemaahBooking({ userId: ownerUser.id, bookingId: booking.id });
  assert(live === null, 'only SETTLED intent → null (terminal not active)');

  // 3. Add a CREATED → returned
  const createdRow = await db.paymentIntent.create({
    data: {
      bookingId: booking.id, provider: 'MIDTRANS',
      orderId: `PI-${tag}-c`,
      amount: '200000', currency: 'IDR',
      status: 'CREATED',
      createdAt: new Date(Date.now() - 30_000),
    },
  });
  live = await getActiveIntentForJemaahBooking({ userId: ownerUser.id, bookingId: booking.id });
  assert(live?.id === createdRow.id, 'CREATED intent returned');

  // 4. Add a PENDING newer than CREATED → newer wins
  const pendingRow = await db.paymentIntent.create({
    data: {
      bookingId: booking.id, provider: 'MIDTRANS',
      orderId: `PI-${tag}-p`,
      amount: '300000', currency: 'IDR',
      status: 'PENDING',
      createdAt: new Date(),
    },
  });
  live = await getActiveIntentForJemaahBooking({ userId: ownerUser.id, bookingId: booking.id });
  assert(live?.id === pendingRow.id, 'newest non-terminal wins (PENDING newer than CREATED)');
  assert(live.status === 'PENDING', 'status string surfaces');

  // 5. Add a newer FAILED → still picks PENDING (terminal ignored regardless of newness)
  await db.paymentIntent.create({
    data: {
      bookingId: booking.id, provider: 'MIDTRANS',
      orderId: `PI-${tag}-f`,
      amount: '400000', currency: 'IDR',
      status: 'FAILED',
      createdAt: new Date(Date.now() + 60_000),
    },
  });
  live = await getActiveIntentForJemaahBooking({ userId: ownerUser.id, bookingId: booking.id });
  assert(live?.id === pendingRow.id, 'newer terminal FAILED ignored, still returns PENDING');

  // 6. Ownership scope — other user gets null even though intent exists
  const otherView = await getActiveIntentForJemaahBooking({ userId: otherUser.id, bookingId: booking.id });
  assert(otherView === null, 'other user gets null (booking.jemaahUserId scope)');

  // Cleanup
  await db.paymentIntent.deleteMany({ where: { bookingId: booking.id } });
  await db.booking.delete({ where: { id: booking.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [ownerUser.jemaah.id, otherUser.jemaah.id] } } });
  await db.user.deleteMany({ where: { id: { in: [ownerUser.id, otherUser.id] } } });
  console.log('  cleanup done');

  console.log('\n[5xx smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5xx smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
