// Stage 376-378 — PWA field utilities:
//   S376 Qibla compass
//   S377 Prayer time integration
//   S378 Offline voucher PDF precache

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
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

// ── S376 — Qibla compass ─────────────────────────────────────

test('S376 — qibla view + route exist', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-qibla.ejs', 'utf8');
  // Ka'bah coordinates baked in
  assert.match(view, /21\.4225/);
  assert.match(view, /39\.8262/);
  // Great-circle bearing formula
  assert.match(view, /computeBearing/);
  assert.match(view, /Math\.atan2/);
  // DeviceOrientation handling with iOS permission gesture
  assert.match(view, /DeviceOrientationEvent\.requestPermission/);
  assert.match(view, /webkitCompassHeading/);
  // Needle rotated by (qibla - heading)
  assert.match(view, /qiblaBearing - currentHeading/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/saya\/ibadah\/qibla/);
});

// ── S377 — Prayer time integration ───────────────────────────

test('S377 — prayer-times.js exposes computeTimes + nextPrayer', async () => {
  const src = await fs.readFile('./shared/prayer-times.js', 'utf8');
  assert.match(src, /window\.PrayerTimes|global\.PrayerTimes/);
  assert.match(src, /computeTimes/);
  assert.match(src, /nextPrayer/);
  // 5 prayers + sunrise
  for (const p of ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    assert.ok(src.includes(p), `prayer ${p} mentioned`);
  }
  // Method allowlist
  assert.match(src, /MWL/);
  assert.match(src, /MAKKAH/);
  // Madhab toggle (Asr)
  assert.match(src, /hanafi/);
  assert.match(src, /shafi/);
});

test('S377 — computeTimes produces sensible Jakarta times', async () => {
  // Load the script into a sandboxed-ish global context
  const src = await fs.readFile('./shared/prayer-times.js', 'utf8');
  const sandbox = { window: {} };
  // The IIFE takes `global` (defaults to window/globalThis). Run it.
  const fn = new Function('window', 'globalThis', src);
  fn.call(sandbox.window, sandbox.window, sandbox.window);
  const PT = sandbox.window.PrayerTimes;
  assert.ok(PT, 'PrayerTimes exposed');
  // Jakarta: -6.2, 106.8, UTC+7. Mid-year summer date so daylight is symmetric.
  const t = PT.computeTimes({
    date: new Date('2026-06-15T00:00:00Z'),
    lat: -6.2, lng: 106.8, tzOffsetHours: 7, method: 'MWL', madhab: 'shafi',
  });
  // Sanity: fajr ~04:30, dhuhr ~12:00 (Jakarta solar noon), maghrib ~17:50
  assert.ok(t.hours.fajr > 3 && t.hours.fajr < 6, `fajr in range: ${t.hm.fajr}`);
  assert.ok(t.hours.dhuhr > 11 && t.hours.dhuhr < 13, `dhuhr in range: ${t.hm.dhuhr}`);
  assert.ok(t.hours.maghrib > 17 && t.hours.maghrib < 19, `maghrib in range: ${t.hm.maghrib}`);
  // Ordering: fajr < sunrise < dhuhr < asr < maghrib < isha
  assert.ok(t.hours.fajr < t.hours.sunrise, 'fajr < sunrise');
  assert.ok(t.hours.sunrise < t.hours.dhuhr, 'sunrise < dhuhr');
  assert.ok(t.hours.dhuhr < t.hours.asr, 'dhuhr < asr');
  assert.ok(t.hours.asr < t.hours.maghrib, 'asr < maghrib');
  assert.ok(t.hours.maghrib < t.hours.isha, 'maghrib < isha');
});

test('S377 — jadwal view + route exist', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-jadwal.ejs', 'utf8');
  assert.match(view, /Jadwal/);
  assert.match(view, /\/shared\/prayer-times\.js/);
  assert.match(view, /nextPrayer/);
  // Method/madhab persisted in localStorage
  assert.match(view, /rp_pt_method/);
  assert.match(view, /rp_pt_madhab/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/saya\/ibadah\/jadwal-shalat/);
});

// ── S378 — Offline voucher PDF precache ──────────────────────

test('S378 — sw.js bumps to v9 + caches voucher PDFs', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  // Version bumped past v8 (S364 baseline)
  assert.match(src, /rp-v(?:9|\d{2,})/);
  // Voucher cache namespace + detector
  assert.match(src, /VOUCHER_CACHE/);
  assert.match(src, /isVoucherPdf/);
  // Cache-first behavior with background refresh
  assert.match(src, /isVoucherPdf\(url\)/);
});

test('S378 — booking detail view auto-precaches voucher PDF', async () => {
  const view = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  assert.match(view, /rp-voucher-cache-pill/);
  // JS fires a fetch to warm the SW cache
  assert.match(view, /voucher\.pdf/);
  // Reads back from the caches API to confirm presence
  assert.match(view, /caches\.keys\(\)/);
  // Three states: ready (cached), pending, fail
  assert.match(view, /paintReady/);
  assert.match(view, /paintPending/);
  assert.match(view, /paintFail/);
  // Waits for SW ready so fetch is intercepted (not raw network)
  assert.match(view, /serviceWorker\.ready/);
});

// ── Integration: routes redirect unauthed ────────────────────

test('S376-S377 — routes redirect unauthed visitors', async () => {
  await withServer(async (port) => {
    for (const path of ['/saya/ibadah/qibla', '/saya/ibadah/jadwal-shalat']) {
      const r = await httpReq({ port, path });
      assert.equal(r.status, 302, `${path} redirects unauthed`);
      assert.match(r.headers.location || '', /\/login/);
    }
  });
});

test('hub view links to all 7 surfaces (thawaf + sai + wukuf + tasbih + jumrah + qibla + jadwal)', async () => {
  const view = await fs.readFile('./views/jemaah-ibadah-hub.ejs', 'utf8');
  assert.match(view, /\/saya\/ibadah\/thawaf/);
  assert.match(view, /\/saya\/ibadah\/sai/);
  assert.match(view, /\/saya\/ibadah\/wukuf/);
  assert.match(view, /\/saya\/ibadah\/tasbih/);
  assert.match(view, /\/saya\/ibadah\/jumrah/);
  assert.match(view, /\/saya\/ibadah\/qibla/);
  assert.match(view, /\/saya\/ibadah\/jadwal-shalat/);
});
