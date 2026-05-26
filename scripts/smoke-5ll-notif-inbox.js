// Smoke test for 5ll — jemaah notif inbox (/saya/notifications).
//
// Verifies:
//   1. enqueueNotification persists recipientUserId.
//   2. listMyNotifications scopes strictly to the calling user (no leakage).
//   3. Admin/system notifs with no recipientUserId never appear in any inbox.
import { db } from '../src/lib/db.js';
import { notifyBookingCreated, enqueueNotification } from '../src/services/notifications.js';
import { listMyNotifications } from '../src/services/jemaahPortal.js';
import { hashPassword } from '../src/lib/auth.js';

const tag = `smoke5ll-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function makeUser(suffix) {
  const email = `${tag}-${suffix}@example.test`;
  const passwordHash = await hashPassword('smoke12345');
  return db.user.create({
    data: {
      email, passwordHash, role: 'JEMAAH',
      fullName: `Smoke ${suffix}`, phone: '+628111111111',
      jemaah: { create: { fullName: `Smoke ${suffix}`, phone: '+628111111111', email } },
    },
    include: { jemaah: true },
  });
}

async function main() {
  console.log(`\n[5ll smoke] tag=${tag}`);
  const userA = await makeUser('A');
  const userB = await makeUser('B');
  console.log(`  userA=${userA.id} userB=${userB.id}`);

  // 1) A jemaah-targeted fan-out (EMAIL + WA) for user A
  await notifyBookingCreated({
    id: 'smoke-ll-1', bookingNo: `RP-SMOKE-A-${tag}`,
    totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
    jemaahUserId: userA.id,
    jemaah: { fullName: userA.fullName, phone: userA.phone, email: userA.email, userId: userA.id },
    paket: { title: 'Smoke Paket' },
  });

  // 2) A jemaah-targeted notif for user B (to test scoping)
  await notifyBookingCreated({
    id: 'smoke-ll-2', bookingNo: `RP-SMOKE-B-${tag}`,
    totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
    jemaahUserId: userB.id,
    jemaah: { fullName: userB.fullName, phone: userB.phone, email: userB.email, userId: userB.id },
    paket: { title: 'Smoke Paket' },
  });

  // 3) Admin/system notif with NO recipientUserId — must not appear in any inbox
  await enqueueNotification({
    type: 'CANCEL_REQUESTED', channel: 'EMAIL',
    recipientEmail: 'admin@example.test',
    subject: 'admin-only', body: 'should not leak to jemaah inbox',
    relatedEntity: 'Booking', relatedEntityId: 'smoke-ll-1',
  });

  // 4) Verify A's inbox
  const inboxA = await listMyNotifications(userA.id);
  console.log(`  inboxA rows: ${inboxA.length} [${inboxA.map((r) => r.channel).join(',')}]`);
  assert(inboxA.length === 2, 'user A sees exactly 2 notifs (their own EMAIL + WA)');
  assert(inboxA.every((r) => r.relatedEntityId === 'smoke-ll-1'), 'all A rows belong to A booking');
  assert(
    inboxA.some((r) => r.channel === 'EMAIL') && inboxA.some((r) => r.channel === 'WA'),
    'A inbox has both EMAIL + WA channels',
  );

  // 5) Verify B's inbox is fully scoped
  const inboxB = await listMyNotifications(userB.id);
  console.log(`  inboxB rows: ${inboxB.length}`);
  assert(inboxB.length === 2, 'user B sees exactly 2 notifs (theirs only)');
  assert(inboxB.every((r) => r.relatedEntityId === 'smoke-ll-2'), 'all B rows belong to B booking');

  // 6) Verify admin notif is invisible to both
  const allAdminLike = await db.notification.findMany({
    where: { subject: 'admin-only' },
    select: { id: true, recipientUserId: true },
  });
  assert(allAdminLike.length === 1, 'admin notif row created');
  assert(allAdminLike[0].recipientUserId === null, 'admin notif has recipientUserId=NULL');

  // 7) Ordering: most recent first (B was created after A)
  // (We only check the per-user list ordering since each has 2 rows; sentinel
  //  is createdAt desc — first row's createdAt >= last row's createdAt.)
  assert(
    inboxA[0].createdAt.getTime() >= inboxA[inboxA.length - 1].createdAt.getTime(),
    'inbox ordered newest-first',
  );

  // Cleanup
  const delIds = [
    ...inboxA.map((r) => r.id),
    ...inboxB.map((r) => r.id),
    ...allAdminLike.map((r) => r.id),
  ];
  await db.notification.deleteMany({ where: { id: { in: delIds } } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [userA.jemaah.id, userB.jemaah.id] } } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: [userA.email, userB.email] } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  console.log(`  cleanup: ${delIds.length} notifs + 2 users + profiles`);

  console.log('\n[5ll smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5ll smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
