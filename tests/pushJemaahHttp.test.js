// Stage 94 — HTTP integration for the /api/saya/push/* surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempJemaah, tempUser } from './_helpers.js';
import { createApp } from '../src/app.js';
import { signToken, COOKIE_NAME } from '../src/lib/jwt.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}
function close(srv) { return new Promise((r) => srv.close(r)); }

function req(srv, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = srv.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function cookieFor(user) {
  const token = signToken({ sub: user.id, role: user.role, email: user.email });
  return `${COOKIE_NAME}=${token}`;
}

async function getCsrf(srv, sessionCookie) {
  // Hit any GET that issues the rp_csrf cookie; /saya works.
  const res = await req(srv, 'GET', '/saya', { Cookie: sessionCookie });
  // Find Set-Cookie containing rp_csrf
  const setCookies = res.headers['set-cookie'] || [];
  for (const sc of setCookies) {
    const m = sc.match(/rp_csrf=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

test('/api/saya/push/config requires JEMAAH session', async (t) => {
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/saya/push/config');
    assert.ok(res.status === 401 || res.status === 302, 'no session → unauth');
  } finally { await close(srv); }
});

test('/api/saya/push/config returns publicKey + mode for JEMAAH', async (t) => {
  const tag = makeTag('pwa-cfg');
  const j = await tempJemaah(t, tag);
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/saya/push/config', { Cookie: cookieFor(j) });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('publicKey' in body);
    assert.ok('mode' in body);
  } finally { await close(srv); }
});

test('/api/saya/push/config refuses ADMIN session (jemaah-only)', async (t) => {
  const tag = makeTag('pwa-admin');
  const admin = await tempUser(t, tag, { role: 'OWNER' });
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/saya/push/config', { Cookie: cookieFor(admin) });
    assert.ok(res.status === 403 || res.status === 401, `expected 403/401, got ${res.status}`);
  } finally { await close(srv); }
});

test('/api/saya/push/subscribe persists the subscription for jemaah', async (t) => {
  const tag = makeTag('pwa-sub');
  const j = await tempJemaah(t, tag);
  const srv = await startServer();
  const cookie = cookieFor(j);
  try {
    const csrf = await getCsrf(srv, cookie);
    assert.ok(csrf, 'csrf token issued');
    const sub = {
      endpoint: `https://example.test/push/${tag}`,
      keys: { p256dh: 'x'.repeat(80), auth: 'y'.repeat(20) },
    };
    const res = await req(srv, 'POST', '/api/saya/push/subscribe',
      { Cookie: `${cookie}; rp_csrf=${csrf}`, 'X-CSRF-Token': csrf },
      JSON.stringify({ subscription: sub }),
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
    const r = JSON.parse(res.body);
    assert.ok(r.ok);
    assert.ok(r.id);

    // Verify DB persisted with correct userId
    const stored = await db.pushSubscription.findUnique({ where: { id: r.id } });
    assert.ok(stored);
    assert.equal(stored.userId, j.id);
    await db.pushSubscription.deleteMany({ where: { id: stored.id } });
  } finally { await close(srv); }
});

test('/api/saya/push/subscribe rejects malformed payload (400)', async (t) => {
  const tag = makeTag('pwa-bad');
  const j = await tempJemaah(t, tag);
  const srv = await startServer();
  const cookie = cookieFor(j);
  try {
    const csrf = await getCsrf(srv, cookie);
    const res = await req(srv, 'POST', '/api/saya/push/subscribe',
      { Cookie: `${cookie}; rp_csrf=${csrf}`, 'X-CSRF-Token': csrf },
      JSON.stringify({ subscription: { endpoint: 'no keys' } }),
    );
    assert.equal(res.status, 400);
  } finally { await close(srv); }
});
