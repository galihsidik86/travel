// Smoke test for 5yy — admin notif on payment intent settled.
//
// Covers:
//   1. Webhook SETTLED → one PAYMENT_SETTLED_ADMIN row per ACTIVE admin
//   2. Recipients are admin emails (NOT the jemaah)
//   3. recipientUserId is NULL on every admin row (anti-leak to jemaah inbox)
//   4. SUSPENDED/deleted admins are skipped
//   5. Non-admin roles (KASIR/AGEN/JEMAAH/MUTHAWWIF) are skipped
//   6. Duplicate webhook (idempotency NOOP) does NOT re-send the fan-out
//   7. Template renders bookingNo, jemaahName, amount placeholders correctly
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
} from '../src/services/paymentGateway.js';

const tag = `smoke5yy-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function mkUser(role, suffix, status = 'ACTIVE', deletedAt = null) {
  const passwordHash = await hashPassword('smoke12345');
  return db.user.create({
    data: {
      email: `${tag}-${suffix}@example.test`, passwordHash, role,
      fullName: `Smoke ${suffix}`, phone: '+62811',
      status, deletedAt,
    },
  });
}

async function main() {
  console.log(`\n[5yy smoke] tag=${tag}`);

  // 3 admins ACTIVE + 1 suspended + 1 deleted + 1 each of non-admin roles
  const owner = await mkUser('OWNER', 'owner');
  const sa    = await mkUser('SUPERADMIN', 'sa');
  const mo    = await mkUser('MANAJER_OPS', 'mo');
  const suspended = await mkUser('OWNER', 'susp', 'SUSPENDED');
  const deleted   = await mkUser('OWNER', 'del', 'ACTIVE', new Date());
  const kasir = await mkUser('KASIR', 'kasir');
  const agen  = await mkUser('AGEN',  'agen');
  const muthawwif = await mkUser('MUTHAWWIF', 'mut');

  // Jemaah + booking fixture
  const jemaahUser = await db.user.create({
    data: {
      email: `${tag}-jem@example.test`, passwordHash: await hashPassword('x'), role: 'JEMAAH',
      fullName: 'Jemaah Test', phone: '+628111',
      jemaah: { create: { fullName: 'Jemaah Test', phone: '+628111', email: `${tag}-jem@example.test` } },
    },
    include: { jemaah: true },
  });
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `5yy-${tag}`, title: 'Paket 5yy',
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: jemaahUser.jemaah.id,
      jemaahUserId: jemaahUser.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });

  // Create intent + settle
  const ctx = { req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null } };
  const intent = await createPaymentIntent({ ...ctx, bookingId: booking.id, amount: 500_000 });
  const settlePayload = buildFakeWebhookPayload({
    orderId: intent.orderId, amount: 500_000, transaction_status: 'settlement',
  });
  const r1 = await handleMidtransNotification({ req: ctx.req, payload: settlePayload });
  assert(r1.action === 'SETTLED', 'webhook settled');

  // 1+2+3: admin fan-out notifs created. Count any existing seeded admins
  // (e.g. owner@religio.pro from seed) so the expectation is dynamic.
  const seededAdminCount = await db.user.count({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE', deletedAt: null, email: { not: '' },
      id: { notIn: [owner.id, sa.id, mo.id, suspended.id, deleted.id, kasir.id, agen.id, muthawwif.id, jemaahUser.id] },
    },
  });
  const expectedNotifCount = 3 + seededAdminCount;

  const adminNotifs = await db.notification.findMany({
    where: { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
    select: { recipientEmail: true, recipientUserId: true, subject: true, body: true },
    orderBy: { recipientEmail: 'asc' },
  });
  assert(adminNotifs.length === expectedNotifCount,
    `expected ${expectedNotifCount} notifs (3 created + ${seededAdminCount} seeded), got ${adminNotifs.length}`);

  const recipients = new Set(adminNotifs.map((n) => n.recipientEmail));
  assert(recipients.has(owner.email) && recipients.has(sa.email) && recipients.has(mo.email),
    'all 3 admins are recipients');
  assert(!recipients.has(jemaahUser.email), 'jemaah NOT a recipient');

  // 3. recipientUserId null (anti-leak to /saya inbox)
  assert(adminNotifs.every((n) => n.recipientUserId === null), 'recipientUserId NULL on all admin rows');

  // 4+5: skipped users
  assert(!recipients.has(suspended.email), 'SUSPENDED admin skipped');
  assert(!recipients.has(deleted.email), 'soft-deleted admin skipped');
  assert(!recipients.has(kasir.email) && !recipients.has(agen.email) && !recipients.has(muthawwif.email),
    'non-admin roles skipped');

  // 7. Template content
  const sample = adminNotifs[0];
  assert(sample.subject.includes(booking.bookingNo), 'subject contains bookingNo');
  assert(sample.subject.includes('500.000'), 'subject contains formatted amount');
  assert(sample.body.includes('Jemaah Test'), 'body contains jemaah name');
  assert(sample.body.includes('LUNAS') === false, 'no LUNAS note on partial payment');
  assert(sample.body.includes('/admin/bookings/'), 'admin deep link present');

  // 6. Duplicate webhook → no second fan-out (idempotency)
  const r2 = await handleMidtransNotification({ req: ctx.req, payload: settlePayload });
  assert(r2.action === 'NOOP', 'duplicate webhook NOOP');
  const adminNotifsAfter = await db.notification.count({
    where: { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
  });
  assert(adminNotifsAfter === expectedNotifCount,
    `still only ${expectedNotifCount} admin notifs after duplicate webhook`);

  // Cleanup
  const allUserIds = [owner.id, sa.id, mo.id, suspended.id, deleted.id, kasir.id, agen.id, muthawwif.id, jemaahUser.id];
  await db.notification.deleteMany({ where: { OR: [
    { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
    { recipientUserId: jemaahUser.id },
    { recipientEmail: jemaahUser.email },
  ] } });
  await db.paymentIntent.deleteMany({ where: { bookingId: booking.id } });
  await db.payment.deleteMany({ where: { bookingId: booking.id } });
  await db.komisi.deleteMany({ where: { bookingId: booking.id } });
  await db.booking.delete({ where: { id: booking.id } });
  await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.delete({ where: { id: jemaahUser.jemaah.id } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: ['sys@test', 'midtrans-webhook', jemaahUser.email] } } });
  await db.user.deleteMany({ where: { id: { in: allUserIds } } });
  console.log('  cleanup done');

  console.log('\n[5yy smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5yy smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
