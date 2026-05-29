// Retention sweep — bounded-growth deletes on Notification / JobRun /
// failed PaymentIntent. Tests deliberately scope all writes by an
// actorEmail/orderId prefix so they don't trip on (or wipe) data from
// other tests sharing the dev DB.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag } from './_helpers.js';
import { pruneRetentionWindows } from '../src/services/retention.js';

const dayAgo = (n) => new Date(Date.now() - n * 86_400_000);

describe('pruneRetentionWindows', () => {
  test('SENT notif older than window is deleted; recent SENT survives', async (t) => {
    const tag = makeTag('ret-sent');
    const made = await Promise.all([
      db.notification.create({ data: {
        type: 'GENERIC', channel: 'CONSOLE',
        recipientEmail: `${tag}-old@example.test`,
        body: tag, status: 'SENT', createdAt: dayAgo(100), sentAt: dayAgo(100),
      } }),
      db.notification.create({ data: {
        type: 'GENERIC', channel: 'CONSOLE',
        recipientEmail: `${tag}-new@example.test`,
        body: tag, status: 'SENT', createdAt: dayAgo(10), sentAt: dayAgo(10),
      } }),
    ]);
    t.after(async () => {
      await db.notification.deleteMany({ where: { body: tag } });
    });

    const r = await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 90, notifFailedDays: 9999, jobRunDays: 9999, intentFailedDays: 9999 },
    });
    assert.ok(r.notifSent.deleted >= 1, 'at least the old SENT row was deleted');
    const left = await db.notification.findMany({ where: { body: tag } });
    assert.equal(left.length, 1, 'recent SENT survives');
    assert.equal(left[0].id, made[1].id);
  });

  test('FAILED-terminal notif (nextRetryAt null OR attemptCount>=5) is pruned', async (t) => {
    const tag = makeTag('ret-failed');
    const [terminal, terminalByCount, retryable] = await Promise.all([
      // nextRetryAt null + status FAILED → terminal
      db.notification.create({ data: {
        type: 'GENERIC', channel: 'CONSOLE', recipientEmail: `${tag}-t1@example.test`,
        body: tag, status: 'FAILED', createdAt: dayAgo(200), nextRetryAt: null, attemptCount: 1,
      } }),
      // attemptCount >= 5 → terminal regardless of nextRetryAt
      db.notification.create({ data: {
        type: 'GENERIC', channel: 'CONSOLE', recipientEmail: `${tag}-t2@example.test`,
        body: tag, status: 'FAILED', createdAt: dayAgo(200), nextRetryAt: dayAgo(1), attemptCount: 5,
      } }),
      // FAILED with retry pending → NOT terminal, stays
      db.notification.create({ data: {
        type: 'GENERIC', channel: 'CONSOLE', recipientEmail: `${tag}-r1@example.test`,
        body: tag, status: 'FAILED', createdAt: dayAgo(200), nextRetryAt: new Date(Date.now() + 60_000), attemptCount: 2,
      } }),
    ]);
    t.after(async () => {
      await db.notification.deleteMany({ where: { body: tag } });
    });

    await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 9999, notifFailedDays: 180, jobRunDays: 9999, intentFailedDays: 9999 },
    });
    const left = await db.notification.findMany({ where: { body: tag } });
    const leftIds = new Set(left.map((r) => r.id));
    assert.ok(!leftIds.has(terminal.id), 'terminal-by-null was pruned');
    assert.ok(!leftIds.has(terminalByCount.id), 'terminal-by-count was pruned');
    assert.ok(leftIds.has(retryable.id), 'retry-pending FAILED survives');
  });

  test('JobRun older than window is deleted', async (t) => {
    const tag = makeTag('ret-jobrun');
    await Promise.all([
      db.jobRun.create({ data: { name: tag, startedAt: dayAgo(200), finishedAt: dayAgo(200), ok: true } }),
      db.jobRun.create({ data: { name: tag, startedAt: dayAgo(30),  finishedAt: dayAgo(30),  ok: true } }),
    ]);
    t.after(async () => {
      await db.jobRun.deleteMany({ where: { name: tag } });
    });
    await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 9999, notifFailedDays: 9999, jobRunDays: 90, intentFailedDays: 9999 },
    });
    const left = await db.jobRun.findMany({ where: { name: tag } });
    assert.equal(left.length, 1, 'recent JobRun survives');
  });

  test('SETTLED PaymentIntent is never pruned, EXPIRED/CANCELLED past window is', async (t) => {
    const tag = makeTag('ret-intent');
    // Need a host booking — minimal fixture.
    const jem = await db.jemaahProfile.create({ data: { fullName: tag, phone: '+62811' } });
    const dep = new Date(Date.now() + 30 * 86_400_000);
    const paket = await db.paket.create({ data: {
      slug: tag, title: tag, departureDate: dep, returnDate: new Date(dep.getTime() + 5 * 86_400_000),
      durationDays: 5, inclusions: [], exclusions: [], kursiTotal: 5, status: 'ACTIVE',
    } });
    const bk = await db.booking.create({ data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    } });
    const settled = await db.paymentIntent.create({ data: {
      bookingId: bk.id, orderId: `PI-${tag}-S`, amount: '1000000', status: 'SETTLED', createdAt: dayAgo(500),
    } });
    const expired = await db.paymentIntent.create({ data: {
      bookingId: bk.id, orderId: `PI-${tag}-E`, amount: '1000000', status: 'EXPIRED', createdAt: dayAgo(500),
    } });
    t.after(async () => {
      await db.paymentIntent.deleteMany({ where: { bookingId: bk.id } });
      await db.booking.deleteMany({ where: { id: bk.id } });
      await db.paket.deleteMany({ where: { id: paket.id } });
      await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
    });

    await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 9999, notifFailedDays: 9999, jobRunDays: 9999, intentFailedDays: 365 },
    });
    const stillSettled = await db.paymentIntent.findUnique({ where: { id: settled.id } });
    const stillExpired = await db.paymentIntent.findUnique({ where: { id: expired.id } });
    assert.ok(stillSettled, 'SETTLED intent NEVER pruned regardless of age');
    assert.equal(stillExpired, null, 'EXPIRED intent past window is deleted');
  });

  test('audit row written when affected > 0; not written when no-op', async (t) => {
    const tag = makeTag('ret-audit');
    await db.notification.create({ data: {
      type: 'GENERIC', channel: 'CONSOLE',
      recipientEmail: `${tag}@example.test`, body: tag,
      status: 'SENT', createdAt: dayAgo(200), sentAt: dayAgo(200),
    } });
    t.after(async () => {
      await db.notification.deleteMany({ where: { body: tag } });
      await db.auditLog.deleteMany({ where: { entity: 'Retention' } });
    });

    const before = await db.auditLog.count({ where: { entity: 'Retention' } });
    await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 90, notifFailedDays: 9999, jobRunDays: 9999, intentFailedDays: 9999 },
    });
    const afterFirst = await db.auditLog.count({ where: { entity: 'Retention' } });
    assert.ok(afterFirst > before, 'audit row written when something deleted');

    // Second run — no-op — should NOT add an audit row.
    await pruneRetentionWindows({
      now: new Date(),
      windows: { notifSentDays: 90, notifFailedDays: 9999, jobRunDays: 9999, intentFailedDays: 9999 },
    });
    const afterSecond = await db.auditLog.count({ where: { entity: 'Retention' } });
    assert.equal(afterSecond, afterFirst, 'no audit row on no-op run');
  });
});
