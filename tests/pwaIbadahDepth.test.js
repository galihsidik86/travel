// Stage 370-372 — PWA jemaah ibadah depth: Wukuf timer, Tasbih counter,
// Jumrah counter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { db } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';

// ── Shape tests ──────────────────────────────────────────────

test('S370 — wukuf view + route exist', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-wukuf.ejs', 'utf8');
  // Three phases
  assert.match(view, /MENUNGGU WUKUF/);
  assert.match(view, /WUKUF SEDANG BERLANGSUNG/);
  assert.match(view, /WUKUF SELESAI/);
  // Pure client-side state
  assert.match(view, /rp_wukuf_start/);
  assert.match(view, /rp_wukuf_end/);
  // Tick every 30s so countdown stays fresh
  assert.match(view, /setInterval\(render, 30_000\)/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/saya\/ibadah\/wukuf/);
  assert.match(route, /jemaah-ibadah-wukuf/);
});

test('S371 — tasbih view + route exist with standard + free modes', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-tasbih.ejs', 'utf8');
  // Three dzikir labels for standard mode
  assert.match(view, /Subhana/);
  assert.match(view, /Alhamdu/);
  assert.match(view, /Akbar/);
  // Distinct counter ids per dzikir position
  assert.match(view, /tasbih_std_0/);
  assert.match(view, /tasbih_std_1/);
  assert.match(view, /tasbih_std_2/);
  // Free mode with configurable target
  assert.match(view, /tasbih_free/);
  assert.match(view, /data-target="33"/);
  // Wake lock + persist storage reused from S365/S367
  assert.match(view, /\/shared\/screen-wake-lock\.js/);
  assert.match(view, /\/shared\/persist-storage\.js/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/saya\/ibadah\/tasbih/);
});

test('S372 — jumrah view + route exist with day tabs + per-jamarat counters', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-jumrah.ejs', 'utf8');
  // 4 days
  assert.match(view, /data-day="10"/);
  assert.match(view, /data-day="11"/);
  assert.match(view, /data-day="12"/);
  assert.match(view, /data-day="13"/);
  // 3 jamarat per day 11-13
  assert.match(view, /sughra/i);
  assert.match(view, /wustha/i);
  assert.match(view, /aqaba/i);
  // Sequential lock: can't throw at Wustha before Sughra complete
  assert.match(view, /isLocked = true/);
  // Counter id pattern jumrah_<day>_<jam>
  assert.match(view, /counterId/);
  assert.match(view, /'jumrah_'/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/saya\/ibadah\/jumrah/);
});

test('hub view links to 5 surfaces (thawaf + sai + wukuf + tasbih + jumrah)', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-hub.ejs', 'utf8');
  assert.match(view, /\/saya\/ibadah\/thawaf/);
  assert.match(view, /\/saya\/ibadah\/sai/);
  assert.match(view, /\/saya\/ibadah\/wukuf/);
  assert.match(view, /\/saya\/ibadah\/tasbih/);
  assert.match(view, /\/saya\/ibadah\/jumrah/);
  // Hub paints aggregate progress for tasbih (99 dhikr) + jumrah (70 stones)
  assert.match(view, /TARGET = 99/);
  assert.match(view, /TARGET = 70/);
});

// ── Route gating via raw http (mirrors leadDuplicateRoute.test.js pattern) ──

import http from 'node:http';
import { createApp } from '../src/app.js';

const app = createApp();

function httpReq({ port, path, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try { return await fn(port); }
  finally { server.close(); }
}

test('S370-S372 — routes redirect unauthed visitors to /login', async () => {
  await withServer(async (port) => {
    for (const path of ['/saya/ibadah/wukuf', '/saya/ibadah/tasbih', '/saya/ibadah/jumrah']) {
      const r = await httpReq({ port, path });
      assert.equal(r.status, 302, `${path} redirects when unauthed`);
      assert.match(r.headers.location || '', /\/login/, `${path} → /login`);
    }
  });
});

test('S370-S372 — routes render HTML for authenticated JEMAAH', async (t) => {
  // Create JEMAAH user + sign-in via /login form (cookie-based session)
  const email = `s370-jemaah-${Date.now()}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'JEMAAH',
      fullName: 'Test S370', phone: '+62811',
      jemaah: { create: { fullName: 'Test S370', phone: '+62811', email } },
    },
  });
  t.after(async () => {
    await db.jemaahProfile.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });

  await withServer(async (port) => {
    // GET /login mints the CSRF cookie
    const probe = await httpReq({ port, path: '/login' });
    const setCookie = probe.headers['set-cookie'] || [];
    const csrfCookie = setCookie.find((c) => c.startsWith('rp_csrf='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
    // POST /login with the form
    const body = `email=${encodeURIComponent(email)}&password=test12345&_csrf=${csrfToken}`;
    const login = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/login', method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Cookie: csrfCookie ? csrfCookie.split(';')[0] : '',
        },
      }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject); req.write(body); req.end();
    });
    assert.equal(login.status, 302, 'login redirects on success');
    const sessionCookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('rp_session='));
    assert.ok(sessionCookie, 'login set rp_session');
    const cookieHeader = [csrfCookie?.split(';')[0], sessionCookie?.split(';')[0]].filter(Boolean).join('; ');

    for (const path of ['/saya/ibadah/wukuf', '/saya/ibadah/tasbih', '/saya/ibadah/jumrah']) {
      const r = await httpReq({ port, path, headers: { Cookie: cookieHeader } });
      assert.equal(r.status, 200, `${path} renders for JEMAAH (got ${r.status})`);
      assert.match(r.body, /<html/i);
    }
  });
});
