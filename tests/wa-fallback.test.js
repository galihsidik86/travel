// Stage 78 — WA fallback when critical EMAIL hits terminal FAILED.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { dispatchNotification, setSender } from '../src/services/notifications.js';

// Helper — install a sender that always fails. Restore a console sender
// after the test so other test files don't see a poisoned EMAIL channel.
const originalConsoleSender = (n) => {
  console.log(`[test:${n.channel}] → ${n.recipientEmail || n.recipientPhone} · ${n.type}`);
  return { ok: true };
};
function withFailingEmailSender(fn) {
  const failingSender = async () => ({ ok: false, error: 'SMTP rejected — mailbox full' });
  setSender('EMAIL', failingSender);
  return Promise.resolve(fn()).finally(() => {
    setSender('EMAIL', originalConsoleSender);
  });
}

test('terminal-FAILED critical EMAIL with phone → WA fallback enqueued', async (t) => {
  const tag = makeTag('waf-critical');
  // Pre-stamp attemptCount=4 so the next failure hits MAX_ATTEMPTS=5 and
  // nextRetryAt=null (terminal).
  const notif = await db.notification.create({
    data: {
      type: 'PAYMENT_RECEIVED', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'bouncy@example.test',
      recipientPhone: '+62811-FAKE',
      subject: 'kuitansi', body: 'pembayaran masuk Rp 1.000.000',
      attemptCount: 4, nextRetryAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: `bk-${tag}`,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({
      where: { OR: [{ id: notif.id }, { relatedEntityId: `bk-${tag}` }] },
    });
  });

  await withFailingEmailSender(() => dispatchNotification(notif));

  const re = await db.notification.findUnique({ where: { id: notif.id } });
  assert.equal(re.attemptCount, 5);
  assert.equal(re.nextRetryAt, null, 'terminal: no more retries scheduled');

  // WA fallback row must exist
  const wa = await db.notification.findFirst({
    where: {
      channel: 'WA',
      type: 'PAYMENT_RECEIVED',
      relatedEntityId: `bk-${tag}`,
    },
  });
  assert.ok(wa, 'WA fallback must be enqueued');
  assert.equal(wa.recipientPhone, '+62811-FAKE');
  assert.equal(wa.payload?.fallbackFromEmail, notif.id);
});

test('non-critical type (admin digest) does NOT trigger fallback', async (t) => {
  const tag = makeTag('waf-noncrit');
  const notif = await db.notification.create({
    data: {
      type: 'DAILY_DIGEST_OWNER', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'owner@example.test',
      recipientPhone: '+62811-DIGEST',
      subject: 'digest', body: 'overview kemarin',
      attemptCount: 4, nextRetryAt: new Date(),
      relatedEntity: null, relatedEntityId: null,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({
      where: { recipientPhone: '+62811-DIGEST' },
    });
  });

  await withFailingEmailSender(() => dispatchNotification(notif));

  const wa = await db.notification.findFirst({
    where: { channel: 'WA', recipientPhone: '+62811-DIGEST' },
  });
  assert.equal(wa, null, 'admin digest must NOT generate a WA fallback');
});

test('non-terminal failure (still retrying) does NOT trigger fallback', async (t) => {
  const tag = makeTag('waf-retry');
  // attemptCount=0 — first attempt fails, retry scheduled, not terminal
  const notif = await db.notification.create({
    data: {
      type: 'PAYMENT_RECEIVED', channel: 'EMAIL', status: 'PENDING',
      recipientEmail: 'flaky@example.test',
      recipientPhone: '+62811-FLAKY',
      subject: 'k', body: '—',
      relatedEntity: 'Booking', relatedEntityId: `bk-${tag}`,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({
      where: { OR: [{ id: notif.id }, { relatedEntityId: `bk-${tag}` }] },
    });
  });

  await withFailingEmailSender(() => dispatchNotification(notif));

  const re = await db.notification.findUnique({ where: { id: notif.id } });
  assert.ok(re.nextRetryAt, 'still has a retry scheduled');
  const wa = await db.notification.findFirst({
    where: { channel: 'WA', recipientPhone: '+62811-FLAKY' },
  });
  assert.equal(wa, null, 'non-terminal failure must not enqueue fallback');
});

test('no phone on file → no fallback (skipped gracefully)', async (t) => {
  const tag = makeTag('waf-nophone');
  const notif = await db.notification.create({
    data: {
      type: 'PAYMENT_RECEIVED', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'nophone@example.test',
      recipientPhone: null,
      subject: 'k', body: '—',
      attemptCount: 4, nextRetryAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: `bk-${tag}`,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: `bk-${tag}` } });
  });

  await withFailingEmailSender(() => dispatchNotification(notif));

  const wa = await db.notification.findFirst({
    where: { channel: 'WA', relatedEntityId: `bk-${tag}` },
  });
  assert.equal(wa, null);
});

test('idempotent: terminal failure does NOT enqueue a 2nd WA when one exists', async (t) => {
  const tag = makeTag('waf-idem');
  const notif = await db.notification.create({
    data: {
      type: 'BOOKING_CREATED', channel: 'EMAIL', status: 'FAILED',
      recipientEmail: 'owner@example.test',
      recipientPhone: '+62811-IDEM',
      subject: 'b', body: '—',
      attemptCount: 4, nextRetryAt: new Date(),
      relatedEntity: 'Booking', relatedEntityId: `bk-${tag}`,
    },
  });
  // Pre-existing WA fallback row from a prior attempt
  await db.notification.create({
    data: {
      type: 'BOOKING_CREATED', channel: 'WA', status: 'PENDING',
      recipientPhone: '+62811-IDEM',
      subject: 'b', body: '—',
      relatedEntity: 'Booking', relatedEntityId: `bk-${tag}`,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: `bk-${tag}` } });
  });

  await withFailingEmailSender(() => dispatchNotification(notif));

  const waRows = await db.notification.findMany({
    where: { channel: 'WA', recipientPhone: '+62811-IDEM' },
  });
  assert.equal(waRows.length, 1, 'must NOT enqueue a second WA row');
});
