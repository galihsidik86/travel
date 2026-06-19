// Stage 355-357 — PWA reach extension: SOS-light offline queue,
// Web Share on paket landing, pre-trip push subscribe CTA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

test('S355 — sos-light-queue.js exposes IndexedDB queue with auto-flush', async () => {
  const src = await fs.readFile('./shared/sos-light-queue.js', 'utf8');
  // Public API matches AttendanceQueue pattern
  assert.match(src, /window\.SosLightQueue/);
  assert.match(src, /enqueue/);
  assert.match(src, /drain/);
  assert.match(src, /startAutoFlush/);
  assert.match(src, /countPending/);
  // IDB store + auto-flush on online event
  assert.match(src, /religio-sos-light/);
  assert.match(src, /'online'/);
  // Sends JSON (not form-encoded) to match /api/saya/help-request contract
  assert.match(src, /application\/json/);
  // ALREADY_PENDING (cooldown collision) treated as success on replay
  assert.match(src, /ALREADY_PENDING/);
});

test('S355 — jemaah-portal.ejs loads sos-light-queue.js + wires offline path', async () => {
  const src = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  assert.match(src, /\/shared\/sos-light-queue\.js/);
  // Submit handler routes to queue when navigator.onLine === false
  assert.match(src, /navigator\.onLine === false/);
  assert.match(src, /SosLightQueue\.enqueue/);
  assert.match(src, /SosLightQueue\.startAutoFlush/);
  // Visible feedback when queued
  assert.match(src, /Queued \(offline\)/);
});

test('S356 — paket.ejs has Web Share button with agent attribution', async () => {
  const src = await fs.readFile('./views/paket.ejs', 'utf8');
  assert.match(src, /rp-paket-share-btn/);
  assert.match(src, /navigator\.share/);
  // Hidden by default, JS feature-detects + reveals
  assert.match(src, /style="display:none/);
  // Agent slug attribution preserved in shared URL
  assert.match(src, /data-agent-slug/);
  assert.match(src, /'\?a=' \+ encodeURIComponent/);
});

test('S357 — jemaah-booking.ejs renders pre-trip push CTA + loads push-jemaah.js', async () => {
  const src = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  // Hidden CTA card with emerald styling
  assert.match(src, /rp-pretrip-push/);
  assert.match(src, /rp-pretrip-push-cta/);
  // Reveals only when permission === 'default'
  assert.match(src, /Notification\.permission !== 'default'/);
  // Proxies clicks to hidden #rp-push-enable owned by push-jemaah.js
  assert.match(src, /getElementById\('rp-push-enable'\)/);
  // push-jemaah.js loaded so the hidden button has a handler
  assert.match(src, /\/shared\/push-jemaah\.js/);
  // Hidden push-bar DOM contract present
  assert.match(src, /id="rp-push-bar"/);
  assert.match(src, /id="rp-push-enable"/);
  assert.match(src, /id="rp-push-disable"/);
});

test('S357 — CTA is scoped to pre-trip non-terminal bookings', async () => {
  const src = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  // The S357 block sits inside the same conditional gate as S349 hero,
  // which checks departureDate + non-terminal status + daysLeft > 0.
  // Easy proxy: the CTA HTML appears between the H-N hero close and the
  // S350 readiness card comment.
  const ctaIdx = src.indexOf('rp-pretrip-push');
  const s349HeroCloseIdx = src.indexOf('hari menuju berangkat');
  const s350CardIdx = src.indexOf('Stage 350 — doc readiness card');
  assert.ok(s349HeroCloseIdx > 0, 'S349 hero present');
  assert.ok(ctaIdx > s349HeroCloseIdx, 'S357 CTA renders after S349 hero');
  assert.ok(ctaIdx < s350CardIdx, 'S357 CTA renders before S350 readiness card');
});
