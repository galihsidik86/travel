// Stage 299 — per-recipient daily cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from './_helpers.js';
import {
  evaluateDailyCap,
  countRecentForRecipient,
  getDailyCapConfig,
} from '../src/services/notifDailyCap.js';

test('getDailyCapConfig: defaults', () => {
  const c = getDailyCapConfig();
  // Defaults: WA 5, EMAIL 15
  assert.equal(c.wa, 5);
  assert.equal(c.email, 15);
});

test('countRecentForRecipient: returns 0 when no rows', async () => {
  const r = await countRecentForRecipient({
    channel: 'WA', recipientPhone: '+62-no-such-phone-xxx',
  });
  assert.equal(r.count, 0);
  assert.equal(r.oldest, null);
});

test('countRecentForRecipient: counts SENT WA within 24h', async (t) => {
  const phone = `+62811-cap-${Math.random().toString().slice(2, 8)}`;
  const created = [];
  for (let i = 0; i < 3; i += 1) {
    const n = await db.notification.create({
      data: {
        type: 'GENERIC', channel: 'WA', status: 'SENT',
        recipientPhone: phone,
        body: `cap test ${i}`,
        sentAt: new Date(Date.now() - i * 3_600_000),
      },
    });
    created.push(n.id);
  }
  t.after(() => db.notification.deleteMany({ where: { id: { in: created } } }));
  const r = await countRecentForRecipient({ channel: 'WA', recipientPhone: phone });
  assert.equal(r.count, 3);
});

test('countRecentForRecipient: ignores PENDING rows (only SENT counts)', async (t) => {
  const phone = `+62811-pending-${Math.random().toString().slice(2, 8)}`;
  const sent = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'WA', status: 'SENT',
      recipientPhone: phone, body: 'sent',
      sentAt: new Date(),
    },
  });
  const pending = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'WA', status: 'PENDING',
      recipientPhone: phone, body: 'pending',
    },
  });
  t.after(() => db.notification.deleteMany({ where: { id: { in: [sent.id, pending.id] } } }));
  const r = await countRecentForRecipient({ channel: 'WA', recipientPhone: phone });
  assert.equal(r.count, 1, 'only SENT counted');
});

test('evaluateDailyCap: urgent type bypasses cap', async () => {
  const notif = {
    type: 'INCIDENT_REPORTED', channel: 'WA',
    recipientPhone: '+62811-urgent', recipientUserId: 'u1',
  };
  const r = await evaluateDailyCap(notif);
  assert.equal(r.defer, false);
});

test('evaluateDailyCap: admin-targeted (no recipientUserId) bypasses cap', async () => {
  const notif = {
    type: 'PAYMENT_REMINDER', channel: 'WA',
    recipientPhone: '+62811-admin', recipientUserId: null,
  };
  const r = await evaluateDailyCap(notif);
  assert.equal(r.defer, false);
});

test('evaluateDailyCap: under cap → not deferred', async (t) => {
  const phone = `+62811-undercap-${Math.random().toString().slice(2, 8)}`;
  // 2 sent rows (under WA default of 5)
  const created = [];
  for (let i = 0; i < 2; i += 1) {
    const n = await db.notification.create({
      data: {
        type: 'GENERIC', channel: 'WA', status: 'SENT',
        recipientPhone: phone,
        body: `under cap ${i}`,
        sentAt: new Date(),
      },
    });
    created.push(n.id);
  }
  t.after(() => db.notification.deleteMany({ where: { id: { in: created } } }));
  const notif = {
    type: 'PAYMENT_REMINDER', channel: 'WA',
    recipientPhone: phone, recipientUserId: 'u1',
  };
  const r = await evaluateDailyCap(notif);
  assert.equal(r.defer, false);
});

test('evaluateDailyCap: over cap → deferred with deferUntil', async (t) => {
  const phone = `+62811-overcap-${Math.random().toString().slice(2, 8)}`;
  // 5 sent rows (at the WA default cap of 5)
  const oldestSent = new Date(Date.now() - 6 * 3_600_000); // oldest 6h ago
  const created = [];
  for (let i = 0; i < 5; i += 1) {
    const n = await db.notification.create({
      data: {
        type: 'GENERIC', channel: 'WA', status: 'SENT',
        recipientPhone: phone,
        body: `over cap ${i}`,
        sentAt: new Date(oldestSent.getTime() + i * 3_600_000),
      },
    });
    created.push(n.id);
  }
  t.after(() => db.notification.deleteMany({ where: { id: { in: created } } }));
  const notif = {
    type: 'PAYMENT_REMINDER', channel: 'WA',
    recipientPhone: phone, recipientUserId: 'u1',
  };
  const r = await evaluateDailyCap(notif);
  assert.equal(r.defer, true);
  assert.ok(r.deferUntil instanceof Date);
  // Defer should be near oldest + 24h
  const expected = new Date(oldestSent.getTime() + 24 * 3_600_000);
  const diff = Math.abs(r.deferUntil.getTime() - expected.getTime());
  assert.ok(diff < 120_000, `defer ~24h after oldest (diff ${diff} ms)`);
});

test('evaluateDailyCap: counts per (recipient, channel) — EMAIL + WA tracked separately', async (t) => {
  const phone = `+62811-pc-${Math.random().toString().slice(2, 8)}`;
  const email = `pc-${Math.random().toString().slice(2, 8)}@test`;
  const created = [];
  // 5 WA (at cap) + 1 EMAIL (way under cap)
  for (let i = 0; i < 5; i += 1) {
    const n = await db.notification.create({
      data: {
        type: 'GENERIC', channel: 'WA', status: 'SENT',
        recipientPhone: phone, body: `${i}`, sentAt: new Date(),
      },
    });
    created.push(n.id);
  }
  const e = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
      recipientEmail: email, body: 'email', sentAt: new Date(),
    },
  });
  created.push(e.id);
  t.after(() => db.notification.deleteMany({ where: { id: { in: created } } }));
  // WA notif → deferred
  const wa = await evaluateDailyCap({
    type: 'PAYMENT_REMINDER', channel: 'WA',
    recipientPhone: phone, recipientUserId: 'u1',
  });
  assert.equal(wa.defer, true);
  // EMAIL notif → not deferred (1/15)
  const em = await evaluateDailyCap({
    type: 'PAYMENT_REMINDER', channel: 'EMAIL',
    recipientEmail: email, recipientUserId: 'u1',
  });
  assert.equal(em.defer, false);
});
