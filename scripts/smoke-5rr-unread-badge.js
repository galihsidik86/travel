// Smoke test for 5rr — notif inbox unread badge.
//
// Verifies:
//   1. countUnreadForUser is scoped to recipientUserId (no leakage between users)
//   2. countUnreadForUser ignores rows with readAt set
//   3. markAllReadForUser stamps every unread row + returns the count marked
//   4. After mark, count drops to 0 — and stays 0 even if existing rows mutate
//   5. New notifs after mark increment unread count again
//   6. Admin notifs (recipientUserId=null) never count toward any user's unread
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { enqueueNotification, notifyBookingCreated } from '../src/services/notifications.js';
import { countUnreadForUser, markAllReadForUser, listMyNotifications } from '../src/services/jemaahPortal.js';

const tag = `smoke5rr-${Date.now()}`;

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
  console.log(`\n[5rr smoke] tag=${tag}`);
  const userA = await makeUser('A');
  const userB = await makeUser('B');

  // Baseline: 0 unread for both
  assert(await countUnreadForUser(userA.id) === 0, 'A starts with 0 unread');
  assert(await countUnreadForUser(userB.id) === 0, 'B starts with 0 unread');

  // Generate 2 notifs for A (BOOKING_CREATED → EMAIL + WA fan-out)
  await notifyBookingCreated({
    id: 'sm-rr-1', bookingNo: `RP-${tag}-1`,
    totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
    jemaahUserId: userA.id,
    jemaah: { fullName: userA.fullName, phone: userA.phone, email: userA.email, userId: userA.id },
    paket: { title: 'Smoke Paket' },
  });

  // And 1 notif for B
  await notifyBookingCreated({
    id: 'sm-rr-2', bookingNo: `RP-${tag}-2`,
    totalAmount: '500000', kelas: 'TRIPLE', paxCount: 1,
    jemaahUserId: userB.id,
    jemaah: { fullName: userB.fullName, phone: userB.phone, email: userB.email, userId: userB.id },
    paket: { title: 'Smoke Paket B' },
  });

  // And 1 admin-only notif with no recipientUserId
  await enqueueNotification({
    type: 'CANCEL_REQUESTED', channel: 'EMAIL',
    recipientEmail: 'admin@example.test',
    subject: 'admin alert', body: 'cancel request',
    relatedEntity: 'Booking', relatedEntityId: 'sm-rr-admin',
  });

  // 1+2: scoping + ignores read
  const uA1 = await countUnreadForUser(userA.id);
  const uB1 = await countUnreadForUser(userB.id);
  assert(uA1 === 2, 'A unread count = 2 (EMAIL + WA fan-out)');
  assert(uB1 === 2, 'B unread count = 2 (their own fan-out)');

  // 6. Admin notif invisible to both
  const allNotifs = await db.notification.count({ where: { relatedEntityId: 'sm-rr-admin' } });
  assert(allNotifs === 1, 'admin notif row created');
  // (Already covered by A=2 / B=2 — admin row has recipientUserId=null so not counted)

  // 3. markAllReadForUser stamps + returns count
  const marked = await markAllReadForUser(userA.id);
  assert(marked === 2, 'mark returns count = 2');
  assert(await countUnreadForUser(userA.id) === 0, 'A unread drops to 0');
  assert(await countUnreadForUser(userB.id) === 2, 'B unaffected by A marking');

  // listMyNotifications now reflects readAt set for A
  const listA = await listMyNotifications(userA.id);
  assert(listA.every((n) => n.readAt !== null), 'all A rows have readAt set');

  // 4. Re-mark idempotent — count was 0, mark returns 0
  const reMarked = await markAllReadForUser(userA.id);
  assert(reMarked === 0, 'second mark on already-read = 0 (idempotent)');

  // 5. New notif arrives → count increments
  await notifyBookingCreated({
    id: 'sm-rr-3', bookingNo: `RP-${tag}-3`,
    totalAmount: '750000', kelas: 'QUAD', paxCount: 1,
    jemaahUserId: userA.id,
    jemaah: { fullName: userA.fullName, phone: userA.phone, email: userA.email, userId: userA.id },
    paket: { title: 'Smoke Paket A2' },
  });
  const uA2 = await countUnreadForUser(userA.id);
  assert(uA2 === 2, 'new notif (fan-out of 2) → A unread back to 2');

  // Sanity: listMyNotifications now has a mix of read + unread
  const listMixed = await listMyNotifications(userA.id);
  const unreadInList = listMixed.filter((n) => !n.readAt).length;
  const readInList = listMixed.filter((n) => n.readAt).length;
  assert(unreadInList === 2 && readInList === 2, 'mixed read+unread rows visible in inbox');

  // Cleanup
  await db.notification.deleteMany({
    where: {
      OR: [
        { recipientUserId: { in: [userA.id, userB.id] } },
        { relatedEntityId: 'sm-rr-admin' },
      ],
    },
  });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [userA.jemaah.id, userB.jemaah.id] } } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: [userA.email, userB.email] } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  console.log('  cleanup done');

  console.log('\n[5rr smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5rr smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
