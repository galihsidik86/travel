// Stage 300 — per-admin notif type opt-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempUser, makeTag } from './_helpers.js';
import {
  getAdminPrefs,
  setAdminPrefs,
  shouldSkipForAdminPrefs,
  ADMIN_NOTIF_TYPES,
} from '../src/services/adminNotifPrefs.js';
import { enqueueNotification } from '../src/services/notifications.js';

test('ADMIN_NOTIF_TYPES: includes core admin types', () => {
  assert.ok(ADMIN_NOTIF_TYPES.includes('CANCEL_REQUESTED'));
  assert.ok(ADMIN_NOTIF_TYPES.includes('DAILY_DIGEST_OWNER'));
  assert.ok(ADMIN_NOTIF_TYPES.includes('INSTALLMENT_OVERDUE_ADMIN'));
  assert.ok(ADMIN_NOTIF_TYPES.includes('DOC_VERIFY_SLA_ADMIN'));
  // Sanity — should NOT include jemaah-side or crew-side types
  assert.ok(!ADMIN_NOTIF_TYPES.includes('PAYMENT_REMINDER'));
  assert.ok(!ADMIN_NOTIF_TYPES.includes('CREW_WEEKLY_DIGEST'));
});

test('getAdminPrefs: returns {} when no prefs set', async (t) => {
  const owner = await tempUser(t, makeTag('anp-empty'), { role: 'OWNER' });
  const r = await getAdminPrefs(owner.id);
  assert.deepEqual(r, {});
});

test('setAdminPrefs: upserts per-type rows', async (t) => {
  const owner = await tempUser(t, makeTag('anp-set'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id,
    prefs: {
      CANCEL_REQUESTED: false,
      DAILY_DIGEST_OWNER: true,
      UNKNOWN_TYPE: false, // should be silently ignored
    },
  });
  const r = await getAdminPrefs(owner.id);
  assert.equal(r.CANCEL_REQUESTED, false);
  assert.equal(r.DAILY_DIGEST_OWNER, true);
  assert.equal(r.UNKNOWN_TYPE, undefined);
});

test('setAdminPrefs: re-setting overwrites', async (t) => {
  const owner = await tempUser(t, makeTag('anp-overwrite'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id,
    prefs: { CANCEL_REQUESTED: false },
  });
  await setAdminPrefs({
    userId: owner.id,
    prefs: { CANCEL_REQUESTED: true },
  });
  const r = await getAdminPrefs(owner.id);
  assert.equal(r.CANCEL_REQUESTED, true);
});

test('shouldSkipForAdminPrefs: returns false when no recipient email', async () => {
  const r = await shouldSkipForAdminPrefs({ type: 'CANCEL_REQUESTED' });
  assert.equal(r.skip, false);
});

test('shouldSkipForAdminPrefs: returns false for non-admin notif type', async (t) => {
  const owner = await tempUser(t, makeTag('anp-nontype'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id, prefs: { CANCEL_REQUESTED: false },
  });
  // Try a non-admin type (PAYMENT_REMINDER is jemaah-side) — should not gate
  const r = await shouldSkipForAdminPrefs({
    type: 'PAYMENT_REMINDER',
    recipientEmail: owner.email,
  });
  assert.equal(r.skip, false);
});

test('shouldSkipForAdminPrefs: skips when admin opted out of this type', async (t) => {
  const owner = await tempUser(t, makeTag('anp-skip'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id, prefs: { CANCEL_REQUESTED: false },
  });
  const r = await shouldSkipForAdminPrefs({
    type: 'CANCEL_REQUESTED',
    recipientEmail: owner.email,
  });
  assert.equal(r.skip, true);
  assert.ok(r.reason.includes('CANCEL_REQUESTED'));
});

test('shouldSkipForAdminPrefs: returns false when admin opted IN (enabled=true)', async (t) => {
  const owner = await tempUser(t, makeTag('anp-keep'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id, prefs: { CANCEL_REQUESTED: true },
  });
  const r = await shouldSkipForAdminPrefs({
    type: 'CANCEL_REQUESTED',
    recipientEmail: owner.email,
  });
  assert.equal(r.skip, false);
});

test('shouldSkipForAdminPrefs: SUSPENDED admin → not gated (return false; opt-out unenforced)', async (t) => {
  const owner = await tempUser(t, makeTag('anp-susp'), { role: 'OWNER', status: 'SUSPENDED' });
  await setAdminPrefs({
    userId: owner.id, prefs: { CANCEL_REQUESTED: false },
  });
  const r = await shouldSkipForAdminPrefs({
    type: 'CANCEL_REQUESTED',
    recipientEmail: owner.email,
  });
  // Suspended admins shouldn't be getting notifs anyway, but the
  // gate doesn't enforce status — it returns false (let through;
  // upstream code handles suspended users separately).
  assert.equal(r.skip, false);
});

test('shouldSkipForAdminPrefs: non-admin User (JEMAAH) → not gated', async (t) => {
  // Make a JEMAAH user and try to gate a notif → must not skip
  // (admin prefs only apply to admin role users)
  const user = await tempUser(t, makeTag('anp-jem'), { role: 'JEMAAH' });
  await db.adminNotifPref.create({
    data: { userId: user.id, type: 'CANCEL_REQUESTED', enabled: false },
  });
  const r = await shouldSkipForAdminPrefs({
    type: 'CANCEL_REQUESTED',
    recipientEmail: user.email,
  });
  assert.equal(r.skip, false, 'jemaah user not gated by admin prefs');
});

test('enqueueNotification: SKIPS when admin opted out of admin-type EMAIL', async (t) => {
  const owner = await tempUser(t, makeTag('anp-enq'), { role: 'OWNER' });
  await setAdminPrefs({
    userId: owner.id, prefs: { CANCEL_REQUESTED: false },
  });
  const r = await enqueueNotification({
    type: 'CANCEL_REQUESTED',
    channel: 'EMAIL',
    recipientEmail: owner.email,
    subject: 'test', body: 'test',
    relatedEntity: 'Booking', relatedEntityId: 'fake',
  });
  assert.equal(r.status, 'SKIPPED');
  assert.ok(r.error?.includes('CANCEL_REQUESTED'));
});
