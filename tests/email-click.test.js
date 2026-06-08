// Stage 77 — email click tracking (token sign/verify + redirect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag } from './_helpers.js';
import { createApp } from '../src/app.js';
import { wrapUrl, unwrapToken } from '../src/lib/emailClickToken.js';

function startServer() {
  const app = createApp();
  return new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
}
function close(s) { return new Promise((r) => s.close(r)); }
function req(s, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = s.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path, headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('wrapUrl + unwrapToken round-trip works', () => {
  const wrapped = wrapUrl('abc123', '/saya/bookings/xyz?q=1');
  assert.match(wrapped, /^\/r\/abc123\./);
  const token = wrapped.replace('/r/', '');
  const decoded = unwrapToken(token);
  assert.equal(decoded.notifId, 'abc123');
  assert.equal(decoded.url, '/saya/bookings/xyz?q=1');
});

test('wrapUrl passes through non-tracked URLs (mailto, anchors)', () => {
  assert.equal(wrapUrl('abc', 'mailto:foo@bar.com'), 'mailto:foo@bar.com');
  assert.equal(wrapUrl('abc', '#fragment'), '#fragment');
  assert.equal(wrapUrl('abc', 'tel:+62811'), 'tel:+62811');
});

test('unwrapToken rejects tampered signature', () => {
  const wrapped = wrapUrl('abc', '/admin');
  const token = wrapped.replace('/r/', '');
  // Flip the last char of the sig
  const parts = token.split('.');
  parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith('a') ? 'b' : 'a');
  assert.equal(unwrapToken(parts.join('.')), null);
});

test('GET /r/<token> 302s to target + records EmailClick row', async (t) => {
  const tag = makeTag('ec-redir');
  const notif = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
      recipientEmail: 'test@example.test',
      subject: 'test', body: '—',
    },
  });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: notif.id } });
    await db.notification.deleteMany({ where: { id: notif.id } });
  });

  const target = '/saya/bookings/abc';
  const wrapped = wrapUrl(notif.id, target);
  const s = await startServer();
  try {
    const res = await req(s, 'GET', wrapped);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, target);
  } finally {
    await close(s);
  }

  const click = await db.emailClick.findFirst({
    where: { notificationId: notif.id },
  });
  assert.ok(click);
  assert.equal(click.targetUrl, target);
  assert.equal(click.clickCount, 1);
});

test('repeat clicks increment clickCount, not duplicate rows', async (t) => {
  const tag = makeTag('ec-repeat');
  const notif = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
      recipientEmail: 'test@example.test',
      subject: 'test', body: '—',
    },
  });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: notif.id } });
    await db.notification.deleteMany({ where: { id: notif.id } });
  });
  const wrapped = wrapUrl(notif.id, '/admin');
  const s = await startServer();
  try {
    await req(s, 'GET', wrapped);
    await req(s, 'GET', wrapped);
    await req(s, 'GET', wrapped);
  } finally {
    await close(s);
  }
  const count = await db.emailClick.count({ where: { notificationId: notif.id } });
  assert.equal(count, 1, 'must collapse to one row');
  const click = await db.emailClick.findFirst({ where: { notificationId: notif.id } });
  assert.equal(click.clickCount, 3);
});

test('GET /r/<bad-token> returns 404', async () => {
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/r/totally-bogus');
    assert.equal(r.status, 404);
  } finally {
    await close(s);
  }
});

test('GET /r/<token> for deleted notif returns 404 (no orphan redirect)', async () => {
  const wrapped = wrapUrl('nonexistent-notif-id', '/saya');
  const s = await startServer();
  try {
    const r = await req(s, 'GET', wrapped);
    assert.equal(r.status, 404);
  } finally {
    await close(s);
  }
});
