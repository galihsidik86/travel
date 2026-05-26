// Smoke test for 5jj — jemaah notif preferences (per-channel opt-out).
//
// Steps:
//   1. Create a fresh JEMAAH user + linked JemaahProfile (notifEmail=true, notifWa=false).
//   2. Trigger notifyBookingCreated directly with a synthetic booking shape
//      (avoids needing a real Paket row + transaction).
//   3. Assert: WA notif row = SKIPPED with the opt-out reason; EMAIL = PENDING.
//   4. Flip prefs (notifEmail=false, notifWa=true), call notifyPaymentReceived
//      (WA only) and re-check.
//   5. Cleanup notifications + user + profile.
import { db } from '../src/lib/db.js';
import { notifyBookingCreated, notifyPaymentReceived } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

const tag = `smoke5jj-${Date.now()}`;
const email = `${tag}@example.test`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log(`\n[5jj smoke] tag=${tag}`);

  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email, passwordHash, role: 'JEMAAH',
      fullName: 'Smoke 5jj',
      phone: '+628111111111',
      jemaah: {
        create: {
          fullName: 'Smoke 5jj',
          phone: '+628111111111',
          email,
          notifEmail: true,
          notifWa: false, // opted out of WA
        },
      },
    },
    include: { jemaah: true },
  });
  console.log(`  user=${user.id} jemaah=${user.jemaah.id}`);

  // Phase 1: BOOKING_CREATED fan-out (EMAIL + WA)
  const fakeBooking = {
    id: 'smoke-booking-1',
    bookingNo: `RP-SMOKE-${tag}`,
    totalAmount: '1000000',
    kelas: 'QUAD',
    paxCount: 1,
    jemaahUserId: user.id,
    jemaah: { fullName: user.fullName, phone: user.phone, email: user.email, userId: user.id },
    paket: { title: 'Smoke Paket' },
  };
  await notifyBookingCreated(fakeBooking);

  const phase1 = await db.notification.findMany({
    where: { relatedEntity: 'Booking', relatedEntityId: 'smoke-booking-1' },
    orderBy: { channel: 'asc' },
  });
  console.log('  phase1 rows:', phase1.map((r) => `${r.channel}/${r.status}/${r.error ?? '-'}`).join(' | '));
  assert(phase1.length === 2, 'fan-out created 2 notif rows');
  const emailRow = phase1.find((r) => r.channel === 'EMAIL');
  const waRow = phase1.find((r) => r.channel === 'WA');
  assert(emailRow?.status === 'PENDING', 'EMAIL stays PENDING when notifEmail=true');
  assert(waRow?.status === 'SKIPPED', 'WA marked SKIPPED when notifWa=false');
  assert(
    waRow?.error === 'recipient opted out of WA notifications',
    'WA skip reason matches expected string',
  );
  assert(waRow?.sentAt != null, 'SKIPPED row gets sentAt set (terminal state)');

  // Phase 2: flip prefs, send WA-only notif (notifyPaymentReceived)
  await db.jemaahProfile.update({
    where: { id: user.jemaah.id },
    data: { notifEmail: false, notifWa: true },
  });
  const fakeBooking2 = { ...fakeBooking, id: 'smoke-booking-2', bookingNo: `RP-SMOKE2-${tag}` };
  const fakePayment = { id: 'smoke-payment-1', amount: '500000', method: 'TRANSFER' };
  await notifyPaymentReceived({ booking: fakeBooking2, payment: fakePayment });

  const phase2 = await db.notification.findMany({
    where: { relatedEntity: 'Payment', relatedEntityId: 'smoke-payment-1' },
  });
  console.log('  phase2 rows:', phase2.map((r) => `${r.channel}/${r.status}/${r.error ?? '-'}`).join(' | '));
  assert(phase2.length === 1 && phase2[0].channel === 'WA', 'payment-received emits 1 WA row');
  assert(phase2[0].status === 'PENDING', 'WA goes PENDING after notifWa flipped back to true');

  // Cleanup
  const deletedNotifs = await db.notification.deleteMany({
    where: { OR: [
      { relatedEntity: 'Booking', relatedEntityId: 'smoke-booking-1' },
      { relatedEntity: 'Payment', relatedEntityId: 'smoke-payment-1' },
    ] },
  });
  await db.jemaahProfile.delete({ where: { id: user.jemaah.id } });
  await db.auditLog.deleteMany({ where: { actorEmail: email } });
  await db.user.delete({ where: { id: user.id } });
  console.log(`  cleanup: ${deletedNotifs.count} notif rows + user + profile + audit`);

  console.log('\n[5jj smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5jj smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
