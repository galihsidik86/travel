import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { dispatchNotification, setSender, enqueueNotification } from '../src/services/notifications.js';
import { wrapUrl, unwrapToken } from '../src/lib/emailClickToken.js';
import { getEmailCtrByType, getEmailClickHeatmap } from '../src/services/emailCtr.js';

function captureSender(captured) {
  return async (n) => { captured.push(n); return { ok: true }; };
}

test('wrapUrl: still works without PUBLIC_BASE_URL — path-only token', () => {
  // .env in dev usually has no PUBLIC_BASE_URL → fallback path
  const out = wrapUrl('n1', '/admin/bookings/abc');
  // Should start with /r/ when no base URL or with http(s) when base URL is set
  assert.ok(out.startsWith('/r/') || /^https?:\/\//.test(out),
    'wrap output should be path or absolute URL, got: ' + out);
});

test('unwrapToken: roundtrip recovers original URL', () => {
  const w = wrapUrl('notif-xyz', '/admin/incidents/abc?ack=ok');
  // Extract just the /r/... part for unwrap test
  const tokenPart = w.replace(/^https?:\/\/[^/]+/, '').replace(/^\/r\//, '');
  const out = unwrapToken(tokenPart);
  assert.ok(out, 'should unwrap a fresh token');
  assert.equal(out.notifId, 'notif-xyz');
  assert.equal(out.url, '/admin/incidents/abc?ack=ok');
});

test('dispatchNotification: WA bodies are wrapped with /r/<token>', async (t) => {
  const captured = [];
  setSender('WA', captureSender(captured));
  t.after(() => setSender('WA', () => ({ ok: true })));

  const tag = makeTag('wa-wrap');
  const notif = await enqueueNotification({
    type: 'BOOKING_CREATED', channel: 'WA',
    recipientPhone: '08111111',
    subject: null,
    body: 'Hi! Cek booking di /admin/bookings/xyz123 ya',
  });
  t.after(async () => { if (notif) await db.notification.delete({ where: { id: notif.id } }); });

  await dispatchNotification(notif);
  assert.equal(captured.length, 1);
  // Body must have been rewritten to include /r/<token>
  assert.match(captured[0].body, /\/r\/.+?\..+?\..+?/,
    'WA body should now carry a tracked /r/<token> link');
});

test('dispatchNotification: WA body without URLs passes through untouched', async (t) => {
  const captured = [];
  setSender('WA', captureSender(captured));
  t.after(() => setSender('WA', () => ({ ok: true })));

  const tag = makeTag('wa-nourl');
  const notif = await enqueueNotification({
    type: 'PAYMENT_RECEIVED', channel: 'WA',
    recipientPhone: '08111112',
    body: 'Pembayaran Rp 500.000 diterima — terima kasih',
  });
  t.after(async () => { if (notif) await db.notification.delete({ where: { id: notif.id } }); });

  await dispatchNotification(notif);
  assert.equal(captured.length, 1);
  assert.ok(!captured[0].body.includes('/r/'), 'no URL → no wrap');
});

test('getEmailCtrByType: aggregates per (type, channel)', async (t) => {
  const tag = makeTag('ctr-ch');
  // 5 EMAIL + 5 WA of the same type, all SENT today
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const e = await db.notification.create({
      data: {
        type: 'BOOKING_CREATED', channel: 'EMAIL', status: 'SENT',
        recipientEmail: `${tag}-e${i}@example.test`, body: 'x', sentAt: new Date(),
      },
    });
    const w = await db.notification.create({
      data: {
        type: 'BOOKING_CREATED', channel: 'WA', status: 'SENT',
        recipientPhone: `0811${i}${tag}`, body: 'x', sentAt: new Date(),
      },
    });
    ids.push(e.id, w.id);
  }
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: { in: ids } } });
    await db.notification.deleteMany({ where: { id: { in: ids } } });
  });

  const r = await getEmailCtrByType({ days: 30 });
  const ebcRow = r.rows.find((x) => x.type === 'BOOKING_CREATED' && x.channel === 'EMAIL');
  const wbcRow = r.rows.find((x) => x.type === 'BOOKING_CREATED' && x.channel === 'WA');
  assert.ok(ebcRow, 'EMAIL/BOOKING_CREATED row present');
  assert.ok(wbcRow, 'WA/BOOKING_CREATED row present');
  assert.ok(ebcRow.sent >= 5);
  assert.ok(wbcRow.sent >= 5);
});

test('getEmailClickHeatmap: respects channel filter', async (t) => {
  const tag = makeTag('hm-ch');
  // 1 EMAIL notif with a click + 1 WA notif with a click — same type
  const emailNotif = await db.notification.create({
    data: {
      type: 'PAYMENT_RECEIVED', channel: 'EMAIL', status: 'SENT',
      recipientEmail: `${tag}@example.test`, body: 'x', sentAt: new Date(),
    },
  });
  const waNotif = await db.notification.create({
    data: {
      type: 'PAYMENT_RECEIVED', channel: 'WA', status: 'SENT',
      recipientPhone: `0811${tag}`, body: 'x', sentAt: new Date(),
    },
  });
  await db.emailClick.create({ data: { notificationId: emailNotif.id, targetUrl: 'http://x/admin/email-only' } });
  await db.emailClick.create({ data: { notificationId: waNotif.id,    targetUrl: 'http://x/admin/wa-only' } });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: { in: [emailNotif.id, waNotif.id] } } });
    await db.notification.deleteMany({ where: { id: { in: [emailNotif.id, waNotif.id] } } });
  });

  const both = await getEmailClickHeatmap({ type: 'PAYMENT_RECEIVED', days: 30 });
  const bothPaths = both.rows.map((r) => r.url);
  assert.ok(bothPaths.includes('/admin/email-only'));
  assert.ok(bothPaths.includes('/admin/wa-only'));

  const emailOnly = await getEmailClickHeatmap({ type: 'PAYMENT_RECEIVED', channel: 'EMAIL', days: 30 });
  const emailPaths = emailOnly.rows.map((r) => r.url);
  assert.ok(emailPaths.includes('/admin/email-only'));
  assert.ok(!emailPaths.includes('/admin/wa-only'), 'WA click must not appear in EMAIL-only filter');

  const waOnly = await getEmailClickHeatmap({ type: 'PAYMENT_RECEIVED', channel: 'WA', days: 30 });
  const waPaths = waOnly.rows.map((r) => r.url);
  assert.ok(waPaths.includes('/admin/wa-only'));
  assert.ok(!waPaths.includes('/admin/email-only'), 'EMAIL click must not appear in WA-only filter');
});
