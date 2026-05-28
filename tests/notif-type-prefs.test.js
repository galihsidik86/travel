// Per-type notif preferences (extends 5jj per-channel opt-out).
//
// Schema-level: composite PK (jemaahId, type), absence = enabled.
// Service-level: setMyNotifTypePrefs upserts, audit only when changed,
//   getMyNotifTypePrefs returns defaults filled in.
// enqueueNotification: per-type wins for SKIP reason; admin-only notifs
//   (no recipientUserId) bypass per-type entirely.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, fakeReq } from './_helpers.js';
import {
  setMyNotifTypePrefs, getMyNotifTypePrefs, JEMAAH_NOTIF_TYPES,
} from '../src/services/jemaahPortal.js';
import { enqueueNotification } from '../src/services/notifications.js';

const ctx = (u) => ({
  req: fakeReq,
  actor: { id: u.id, email: u.email, role: u.role },
  userId: u.id,
});

describe('JEMAAH_NOTIF_TYPES — UI surface', () => {
  test('lists jemaah-relevant types, excludes admin/agent-only', () => {
    assert.ok(JEMAAH_NOTIF_TYPES.includes('BOOKING_CREATED'));
    assert.ok(JEMAAH_NOTIF_TYPES.includes('PAYMENT_RECEIVED'));
    assert.ok(JEMAAH_NOTIF_TYPES.includes('REFUND_ISSUED'));
    // Admin-only notifs not exposed
    assert.ok(!JEMAAH_NOTIF_TYPES.includes('CANCEL_REQUESTED'));
    assert.ok(!JEMAAH_NOTIF_TYPES.includes('PAYMENT_SETTLED_ADMIN'));
    // Agent-only
    assert.ok(!JEMAAH_NOTIF_TYPES.includes('PAYOUT_CREATED'));
  });
});

describe('getMyNotifTypePrefs — defaults', () => {
  test('absence of rows → all types report enabled:true', async (t) => {
    const tag = makeTag('typepref-defaults');
    const user = await tempJemaah(t, tag);
    const prefs = await getMyNotifTypePrefs(user.id);
    for (const type of JEMAAH_NOTIF_TYPES) {
      assert.equal(prefs[type], true, `${type} default = true`);
    }
  });
});

describe('setMyNotifTypePrefs — upsert + diff audit', () => {
  test('first opt-out writes row + audit; same-value re-save no audit row', async (t) => {
    const tag = makeTag('typepref-upsert');
    const user = await tempJemaah(t, tag);
    t.after(() => db.auditLog.deleteMany({ where: { actorEmail: user.email } }));

    // Initial state: all enabled (no rows)
    const state1 = await setMyNotifTypePrefs({
      ...ctx(user),
      prefs: { PAYMENT_RECEIVED: false },
    });
    assert.equal(state1.PAYMENT_RECEIVED, false);
    assert.equal(state1.BOOKING_CREATED, true, 'untouched types remain default');

    const auditCount1 = await db.auditLog.count({ where: { actorEmail: user.email, entity: 'JemaahProfile' } });
    assert.equal(auditCount1, 1, 'one audit row for the change');

    // Re-save same value → no-op, no new audit
    await setMyNotifTypePrefs({
      ...ctx(user),
      prefs: { PAYMENT_RECEIVED: false },
    });
    const auditCount2 = await db.auditLog.count({ where: { actorEmail: user.email, entity: 'JemaahProfile' } });
    assert.equal(auditCount2, 1, 'no audit row for no-op re-save');

    // Flip back to true → new audit row
    const state2 = await setMyNotifTypePrefs({
      ...ctx(user),
      prefs: { PAYMENT_RECEIVED: true },
    });
    assert.equal(state2.PAYMENT_RECEIVED, true);
    const auditCount3 = await db.auditLog.count({ where: { actorEmail: user.email, entity: 'JemaahProfile' } });
    assert.equal(auditCount3, 2);
  });

  test('unknown type keys silently ignored', async (t) => {
    const tag = makeTag('typepref-unknown');
    const user = await tempJemaah(t, tag);
    const state = await setMyNotifTypePrefs({
      ...ctx(user),
      prefs: { CANCEL_REQUESTED: false, NOT_A_REAL_TYPE: true, REFUND_ISSUED: false },
    });
    assert.equal(state.REFUND_ISSUED, false, 'valid key applied');
    // Unknown / admin-only keys silently dropped — not present in returned state
    assert.ok(!('CANCEL_REQUESTED' in state), 'admin-only type not in jemaah surface');
    assert.ok(!('NOT_A_REAL_TYPE' in state), 'invalid type discarded');
  });
});

describe('enqueueNotification — per-type opt-out interaction', () => {
  test('type-disabled → SKIPPED with type-specific reason', async (t) => {
    const tag = makeTag('typepref-enq');
    const user = await tempJemaah(t, tag);
    await setMyNotifTypePrefs({ ...ctx(user), prefs: { PAYMENT_RECEIVED: false } });

    const row = await enqueueNotification({
      type: 'PAYMENT_RECEIVED', channel: 'WA',
      recipientPhone: user.phone, recipientUserId: user.id,
      body: 'test', relatedEntityId: tag,
    });
    t.after(() => db.notification.deleteMany({ where: { id: row.id } }));
    assert.equal(row.status, 'SKIPPED');
    assert.match(row.error, /opted out of PAYMENT_RECEIVED/);
  });

  test('different type → still PENDING (per-type is per-row, not per-user)', async (t) => {
    const tag = makeTag('typepref-other');
    const user = await tempJemaah(t, tag);
    await setMyNotifTypePrefs({ ...ctx(user), prefs: { PAYMENT_RECEIVED: false } });

    const row = await enqueueNotification({
      type: 'BOOKING_CREATED', channel: 'WA',
      recipientPhone: user.phone, recipientUserId: user.id,
      body: 'test', relatedEntityId: tag,
    });
    t.after(() => db.notification.deleteMany({ where: { id: row.id } }));
    assert.equal(row.status, 'PENDING', 'other type unaffected');
  });

  test('per-type wins over per-channel for reason text (more actionable)', async (t) => {
    const tag = makeTag('typepref-precedence');
    const user = await tempJemaah(t, tag);
    // Opt out of both: WA channel AND PAYMENT_RECEIVED type
    await db.jemaahProfile.update({
      where: { id: user.jemaah.id },
      data: { notifWa: false },
    });
    await setMyNotifTypePrefs({ ...ctx(user), prefs: { PAYMENT_RECEIVED: false } });

    const row = await enqueueNotification({
      type: 'PAYMENT_RECEIVED', channel: 'WA',
      recipientPhone: user.phone, recipientUserId: user.id,
      body: 'test', relatedEntityId: tag,
    });
    t.after(() => db.notification.deleteMany({ where: { id: row.id } }));
    assert.equal(row.status, 'SKIPPED');
    assert.match(row.error, /PAYMENT_RECEIVED/,
      'per-type reason wins over per-channel — more specific = more actionable');
  });

  test('admin-only notif (no recipientUserId) bypasses per-type check', async (t) => {
    const tag = makeTag('typepref-admin');
    // No fixture user needed — recipientUserId absent
    const row = await enqueueNotification({
      type: 'PAYMENT_RECEIVED', channel: 'EMAIL',
      recipientEmail: 'admin@example.test',
      // NO recipientUserId
      body: 'admin alert', relatedEntityId: tag,
    });
    t.after(() => db.notification.deleteMany({ where: { id: row.id } }));
    assert.equal(row.status, 'PENDING', 'no recipientUserId → no per-type lookup, ships normally');
  });
});
