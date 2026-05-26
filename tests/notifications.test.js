// Notifications subsystem integration tests.
// Bundles: 5jj opt-out · 5ll inbox scoping · 5nn retry-with-backoff
//        · 5rr unread badge · 5yy admin settled fan-out.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq, systemActor } from './_helpers.js';
import {
  enqueueNotification, processPendingNotifications, dispatchNotification,
  setSender, MAX_ATTEMPTS,
  notifyBookingCreated, notifyPaymentReceived,
} from '../src/services/notifications.js';
import { listMyNotifications, countUnreadForUser, markAllReadForUser } from '../src/services/jemaahPortal.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
} from '../src/services/paymentGateway.js';

// 5nn block uses a stubbed WA sender; restored in `after()` to a benign
// always-ok sender so leftover queue entries from prior tests don't fail.

describe('5jj: per-channel opt-out', () => {
  test('notifWa=false marks WA row SKIPPED with reason; EMAIL stays PENDING', async (t) => {
    const tag = makeTag('5jj-optout');
    const user = await tempJemaah(t, tag);
    await db.jemaahProfile.update({
      where: { id: user.jemaah.id },
      data: { notifEmail: true, notifWa: false },
    });

    const fakeBooking = {
      id: tag, bookingNo: tag,
      totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
      jemaahUserId: user.id,
      jemaah: { fullName: user.fullName, phone: user.phone, email: user.email, userId: user.id },
      paket: { title: 'Test Paket' },
    };
    t.after(() => db.notification.deleteMany({ where: { relatedEntityId: tag } }));

    await notifyBookingCreated(fakeBooking);
    const rows = await db.notification.findMany({
      where: { relatedEntityId: tag }, orderBy: { channel: 'asc' },
    });
    assert.equal(rows.length, 2, 'fan-out creates 2 rows');
    const emailRow = rows.find((r) => r.channel === 'EMAIL');
    const waRow = rows.find((r) => r.channel === 'WA');
    assert.equal(emailRow.status, 'PENDING', 'EMAIL not opted out → PENDING');
    assert.equal(waRow.status, 'SKIPPED', 'WA opted out → SKIPPED');
    assert.equal(waRow.error, 'recipient opted out of WA notifications');
    assert.ok(waRow.sentAt, 'SKIPPED row gets sentAt (terminal)');
  });
});

describe('5ll: inbox scoping (recipientUserId)', () => {
  test('A and B only see their own; admin notif (null userId) visible to neither', async (t) => {
    const tag = makeTag('5ll');
    const userA = await tempJemaah(t, `${tag}-a`);
    const userB = await tempJemaah(t, `${tag}-b`);
    t.after(() => db.notification.deleteMany({
      where: { OR: [
        { recipientUserId: { in: [userA.id, userB.id] } },
        { relatedEntityId: `${tag}-admin` },
      ] },
    }));

    // Each user gets a booking-created fan-out (EMAIL + WA)
    for (const u of [userA, userB]) {
      await notifyBookingCreated({
        id: `${tag}-${u.id}`, bookingNo: `BN-${u.id}`,
        totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
        jemaahUserId: u.id,
        jemaah: { fullName: u.fullName, phone: u.phone, email: u.email, userId: u.id },
        paket: { title: 'Test Paket' },
      });
    }
    // Admin-targeted notif (no recipientUserId)
    await enqueueNotification({
      type: 'CANCEL_REQUESTED', channel: 'EMAIL',
      recipientEmail: 'admin@example.test',
      subject: 'admin-only', body: 'no leak',
      relatedEntity: 'Booking', relatedEntityId: `${tag}-admin`,
    });

    const inboxA = await listMyNotifications(userA.id);
    const inboxB = await listMyNotifications(userB.id);
    assert.equal(inboxA.length, 2, 'A sees own 2 rows');
    assert.equal(inboxB.length, 2, 'B sees own 2 rows');
    assert.ok(inboxA.every((n) => n.relatedEntityId === `${tag}-${userA.id}`), 'A scoped');
    assert.ok(inboxB.every((n) => n.relatedEntityId === `${tag}-${userB.id}`), 'B scoped');
  });
});

describe('5nn: retry with exponential backoff', () => {
  let originalSender;
  before(() => {
    // Capture current WA sender so we can restore after the suite.
    originalSender = null; // setSender doesn't expose get; we'll set back to a console-equivalent
  });
  after(() => {
    // Restore a benign sender — anything passing-by would just succeed.
    setSender('WA', () => ({ ok: true }));
  });

  test('fails → backoff scheduled → exhaustion terminal → admin reset works', async (t) => {
    const tag = makeTag('5nn');
    let mode = 'fail';
    setSender('WA', () => mode === 'fail' ? { ok: false, error: 'stub fail' } : { ok: true });

    const row = await enqueueNotification({
      type: 'PAYMENT_RECEIVED', channel: 'WA',
      recipientPhone: '0812-3456-7890',
      body: `retry-${tag}`,
      relatedEntity: 'Booking', relatedEntityId: tag,
    });
    t.after(() => db.notification.deleteMany({ where: { id: row.id } }));

    // Dispatch our specific row directly. processPendingNotifications would
    // also work but its 100-row LIMIT + oldest-first ordering means heavy
    // leftover queues from other tests can starve our row out of the window.
    // Dispatching by id is the parallel-safe way to test retry state-machine.
    async function dispatchOurs() {
      const fresh = await db.notification.findUnique({ where: { id: row.id } });
      return dispatchNotification(fresh);
    }

    // 1st attempt fails → attemptCount=1 + ~1min backoff
    await dispatchOurs();
    let cur = await db.notification.findUnique({ where: { id: row.id } });
    assert.equal(cur.status, 'FAILED');
    assert.equal(cur.attemptCount, 1);
    const firstDelay = cur.nextRetryAt.getTime() - Date.now();
    assert.ok(firstDelay > 55_000 && firstDelay <= 65_000, `1st backoff ~1min (got ${firstDelay}ms)`);

    // Drive to exhaustion by dispatching directly (real queue would respect
    // backoff, but our direct call models the "backoff window elapsed" path).
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      await dispatchOurs();
      cur = await db.notification.findUnique({ where: { id: row.id } });
      assert.equal(cur.attemptCount, i, `attempt ${i} consumed`);
    }
    assert.equal(cur.status, 'FAILED');
    assert.equal(cur.nextRetryAt, null, `terminal at attempt ${MAX_ATTEMPTS}`);

    // Admin reset (manual "Send now" pattern) + sender flipped → SENT
    mode = 'ok';
    await db.notification.update({
      where: { id: row.id },
      data: { status: 'PENDING', attemptCount: 0, nextRetryAt: null, error: null },
    });
    await dispatchOurs();
    cur = await db.notification.findUnique({ where: { id: row.id } });
    assert.equal(cur.status, 'SENT');
    assert.equal(cur.attemptCount, 1);
    assert.equal(cur.nextRetryAt, null, 'SENT is terminal');
  });
});

describe('5rr: unread badge', () => {
  test('count scoped per user, mark idempotent, new notif re-increments', async (t) => {
    const tag = makeTag('5rr');
    const userA = await tempJemaah(t, `${tag}-a`);
    const userB = await tempJemaah(t, `${tag}-b`);
    t.after(() => db.notification.deleteMany({
      where: { recipientUserId: { in: [userA.id, userB.id] } },
    }));

    assert.equal(await countUnreadForUser(userA.id), 0, 'A baseline 0');

    // Booking-created fan-out for A (2 rows) and B (2 rows)
    for (const u of [userA, userB]) {
      await notifyBookingCreated({
        id: `${tag}-${u.id}`, bookingNo: `BN-${u.id}`,
        totalAmount: '1000000', kelas: 'QUAD', paxCount: 1,
        jemaahUserId: u.id,
        jemaah: { fullName: u.fullName, phone: u.phone, email: u.email, userId: u.id },
        paket: { title: 'P' },
      });
    }
    assert.equal(await countUnreadForUser(userA.id), 2);
    assert.equal(await countUnreadForUser(userB.id), 2);

    // Mark A → 0, B unaffected
    const marked = await markAllReadForUser(userA.id);
    assert.equal(marked, 2, 'mark returns count');
    assert.equal(await countUnreadForUser(userA.id), 0);
    assert.equal(await countUnreadForUser(userB.id), 2, 'B untouched');

    // Re-mark idempotent
    assert.equal(await markAllReadForUser(userA.id), 0, 'second mark = 0');

    // New notif re-increments
    await notifyPaymentReceived({
      booking: {
        id: `${tag}-bk2`, bookingNo: `BN-${tag}-2`,
        jemaahUserId: userA.id,
        jemaah: { fullName: userA.fullName, phone: userA.phone, email: userA.email, userId: userA.id },
      },
      payment: { id: 'fake-pay', amount: '100000', method: 'TRANSFER' },
    });
    assert.equal(await countUnreadForUser(userA.id), 1, 'new WA notif → A unread = 1');
  });
});

describe('5yy: admin fan-out on payment settled', () => {
  test('fan-out one EMAIL per ACTIVE admin; jemaah/inactive/non-admin skipped; idempotent', async (t) => {
    const tag = makeTag('5yy');
    const adminA = await tempUser(t, `${tag}-aa`, { role: 'OWNER' });
    const adminB = await tempUser(t, `${tag}-bb`, { role: 'MANAJER_OPS' });
    const suspended = await tempUser(t, `${tag}-susp`, { role: 'OWNER', status: 'SUSPENDED' });
    const nonAdmin = await tempUser(t, `${tag}-ks`, { role: 'KASIR' });

    const user = await tempJemaah(t, `${tag}-jem`);
    const paket = await tempPaket(t, `${tag}-pk`);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    const intent = await createPaymentIntent({ req: fakeReq, actor: systemActor, bookingId: booking.id, amount: 500_000 });
    t.after(() => db.notification.deleteMany({
      where: { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
    }));

    const payload = buildFakeWebhookPayload({
      orderId: intent.orderId, amount: 500_000, transaction_status: 'settlement',
    });
    await handleMidtransNotification({ req: fakeReq, payload });

    const notifs = await db.notification.findMany({
      where: { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
    });
    const recipients = new Set(notifs.map((n) => n.recipientEmail));
    assert.ok(recipients.has(adminA.email), 'admin A fanned-out');
    assert.ok(recipients.has(adminB.email), 'admin B fanned-out');
    assert.ok(!recipients.has(suspended.email), 'SUSPENDED skipped');
    assert.ok(!recipients.has(nonAdmin.email), 'KASIR skipped');
    assert.ok(!recipients.has(user.email), 'jemaah NOT recipient');
    assert.ok(notifs.every((n) => n.recipientUserId === null), 'admin rows have NULL recipientUserId (anti-leak to /saya inbox)');

    // Duplicate webhook → idempotent: no second fan-out
    const before2 = notifs.length;
    await handleMidtransNotification({ req: fakeReq, payload });
    const after2 = await db.notification.count({
      where: { type: 'PAYMENT_SETTLED_ADMIN', relatedEntityId: intent.id },
    });
    assert.equal(after2, before2, 'duplicate webhook → no new admin notifs');
  });
});
