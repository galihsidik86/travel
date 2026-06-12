// Stage 225 — bulk retry FAILED notifications from /admin/notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { bulkRetryFailedNotifications, setSender } from '../src/services/notifications.js';

// Always-OK CONSOLE sender so dispatches in this test land as SENT.
let originalSender;
test.before(() => {
  originalSender = (n) => ({ ok: true, info: { stub: true } });
  setSender('CONSOLE', originalSender);
});

async function makeFailedNotif(tag, suffix = '') {
  const row = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'CONSOLE',
      status: 'FAILED',
      subject: `s225 ${tag}${suffix}`, body: 'body',
      attemptCount: 5, nextRetryAt: null,
      error: 'simulated terminal failure',
      relatedEntity: 'TestStage225', relatedEntityId: `${tag}${suffix}`,
    },
  });
  return row;
}

async function cleanup(tag) {
  await db.notification.deleteMany({ where: { relatedEntity: 'TestStage225', relatedEntityId: { startsWith: tag } } });
}

test('bulkRetryFailedNotifications: empty ids → zero counters', async () => {
  const r = await bulkRetryFailedNotifications({ ids: [] });
  assert.deepEqual(r, { requested: 0, eligible: 0, retried: 0, failed: 0, skipped: 0 });
});

test('bulkRetryFailedNotifications: resets attemptCount + flips status to SENT (using OK CONSOLE sender)', async (t) => {
  const tag = makeTag('s225-reset');
  const r1 = await makeFailedNotif(tag, '-a');
  t.after(async () => { await cleanup(tag); });

  const result = await bulkRetryFailedNotifications({ ids: [r1.id] });
  assert.equal(result.requested, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.failed, 0);

  const after = await db.notification.findUnique({ where: { id: r1.id } });
  // Status flipped (PENDING → SENT via dispatchNotification with OK CONSOLE sender)
  assert.equal(after.status, 'SENT');
  // attemptCount NOT 5 anymore (was reset, then bumped by dispatch's success path)
  // Note: success path also bumps attemptCount once. So expect 1, not 5.
  assert.equal(after.attemptCount, 1);
});

test('bulkRetryFailedNotifications: skips non-FAILED rows silently', async (t) => {
  const tag = makeTag('s225-skip');
  const sentRow = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'CONSOLE',
      status: 'SENT', sentAt: new Date(),
      subject: 'x', body: 'y',
      relatedEntity: 'TestStage225', relatedEntityId: `${tag}-sent`,
    },
  });
  const failedRow = await makeFailedNotif(tag, '-f');
  t.after(async () => { await cleanup(tag); });

  // Pass BOTH ids — only the FAILED one should retry
  const result = await bulkRetryFailedNotifications({ ids: [sentRow.id, failedRow.id] });
  assert.equal(result.requested, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.skipped, 1);

  // SENT row is untouched
  const sentAfter = await db.notification.findUnique({ where: { id: sentRow.id } });
  assert.equal(sentAfter.status, 'SENT');
});

test('bulkRetryFailedNotifications: caps at limit', async (t) => {
  const tag = makeTag('s225-cap');
  const ids = Array.from({ length: 10 }, (_, i) => `${tag}-fake-${i}`);
  // No real rows — verify cap on requested
  const r = await bulkRetryFailedNotifications({ ids, limit: 3 });
  assert.equal(r.requested, 3);
  assert.equal(r.eligible, 0);
  assert.equal(r.retried, 0);
});

test('bulkRetryFailedNotifications: unknown ids → eligible=0, no errors', async (t) => {
  const tag = makeTag('s225-unknown');
  const r = await bulkRetryFailedNotifications({ ids: [`${tag}-doesnotexist`] });
  assert.equal(r.requested, 1);
  assert.equal(r.eligible, 0);
  assert.equal(r.skipped, 1);
});

test('bulkRetryFailedNotifications: mix of valid + invalid ids partial-success', async (t) => {
  const tag = makeTag('s225-mix');
  const real = await makeFailedNotif(tag, '-real');
  t.after(async () => { await cleanup(tag); });

  const r = await bulkRetryFailedNotifications({ ids: [real.id, 'phony-id'] });
  assert.equal(r.requested, 2);
  assert.equal(r.eligible, 1);
  assert.equal(r.retried, 1);
  assert.equal(r.skipped, 1);
});

test('bulkRetryFailedNotifications: ignores falsy ids in input array', async () => {
  const r = await bulkRetryFailedNotifications({ ids: [null, undefined, '', 'real-but-fake'] });
  // null/undefined/empty stripped; only 'real-but-fake' counted
  assert.equal(r.requested, 1);
});
