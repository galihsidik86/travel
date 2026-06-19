// Stage 352-354 — PWA comms polish: in-app toast + Web Share + quick-contact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

test('S352 — sw.js push handler posts message to clients + bumps CACHE_VERSION', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  // Version may have bumped further (S361 → v7); just assert >= v6.
  assert.match(src, /CACHE_VERSION = 'rp-v(?:[6-9]|\d{2,})'/, 'CACHE_VERSION at v6 or higher');
  // SW posts message to clients with kind:rp-push
  assert.match(src, /kind: 'rp-push'/);
  assert.match(src, /clients\.matchAll/);
  assert.match(src, /c\.postMessage/);
  // Still calls showNotification (browser-policy requirement)
  assert.match(src, /self\.registration\.showNotification/);
});

test('S352 — shared/in-app-toast.js listens for SW message + renders banner', async () => {
  const src = await fs.readFile('./shared/in-app-toast.js', 'utf8');
  assert.match(src, /navigator\.serviceWorker\.addEventListener\('message'/);
  assert.match(src, /kind !== 'rp-push'/);
  assert.match(src, /renderToast/);
  // SOS-tagged toasts skip auto-dismiss (manual close only)
  assert.match(src, /sos/i);
});

test('S352 — pwa-head.ejs includes in-app-toast.js', async () => {
  const src = await fs.readFile('./views/partials/pwa-head.ejs', 'utf8');
  assert.match(src, /\/shared\/in-app-toast\.js/);
});

test('S353 — jemaah-booking.ejs has Web Share button with verifyUrl', async () => {
  const src = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  assert.match(src, /rp-share-btn/);
  assert.match(src, /navigator\.share/);
  assert.match(src, /verifyUrl/);
  // Hidden by default; revealed only when navigator.share exists
  assert.match(src, /style="display:none/);
});

test('S354 — env.js declares PUBLIC_ADMIN_WA + PUBLIC_ADMIN_PHONE', async () => {
  const src = await fs.readFile('./src/env.js', 'utf8');
  assert.match(src, /PUBLIC_ADMIN_WA/);
  assert.match(src, /PUBLIC_ADMIN_PHONE/);
});

test('S354 — quick-contact panel exists on jemaah-booking with tel: + wa.me/ links', async () => {
  const src = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  assert.match(src, /Kontak cepat/);
  assert.match(src, /wa\.me\//);
  assert.match(src, /href="tel:/);
  // Walk-in fallback note when no agent
  assert.match(src, /walk-in/);
});

test('S354 — app.js exposes publicAdminWa/Phone on res.locals', async () => {
  const src = await fs.readFile('./src/app.js', 'utf8');
  assert.match(src, /res\.locals\.publicAdminWa/);
  assert.match(src, /res\.locals\.publicAdminPhone/);
});
