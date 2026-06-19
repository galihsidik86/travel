// Stage 364-366 — PWA in-trip refinement:
//   S364 crew offline manifest via SWR
//   S365 Screen Wake Lock for Ibadah counters
//   S366 App Badging for unread notifs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

// ── S364 — crew offline manifest ─────────────────────────────

test('S364 — sw.js adds /crew/paket/ to SWR prefix list + bumps version', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  assert.match(src, /SWR_PATH_PREFIXES = \[[^\]]*\/crew\/paket\//);
  // Version bumped past v7 (S361 baseline) so installed clients pick up
  // the new SWR scope on next activation.
  assert.match(src, /rp-v(?:[8-9]|\d{2,})/);
});

test('S364 — crew-manifest.ejs renders per-slug last-synced badge', async () => {
  const src = await fs.readFile('./views/crew-manifest.ejs', 'utf8');
  assert.match(src, /rp-manifest-sync/);
  // Per-paket localStorage key so each manifest tracks its own freshness
  assert.match(src, /rp_crew_manifest_last_sync__/);
  assert.match(src, /data-slug/);
  // Online + offline branches
  assert.match(src, /navigator\.onLine/);
  assert.match(src, /OFFLINE/);
  assert.match(src, /Sinkron/i);
});

// ── S365 — Screen Wake Lock ──────────────────────────────────

test('S365 — screen-wake-lock.js exposes acquire/release API', async () => {
  const src = await fs.readFile('./shared/screen-wake-lock.js', 'utf8');
  assert.match(src, /ScreenWakeLock/);
  assert.match(src, /acquire/);
  assert.match(src, /release/);
  // Uses Screen Wake Lock API
  assert.match(src, /wakeLock\.request\('screen'\)/);
  // Re-acquires on visibility return so OS auto-release doesn't permanently kill the lock
  assert.match(src, /visibilitychange/);
  // Silently no-op on unsupported browsers
  assert.match(src, /'wakeLock' in navigator/);
});

test('S365 — thawaf + sai views load wake-lock + acquire on enter', async () => {
  for (const view of ['./views/jemaah-ibadah-thawaf.ejs', './views/jemaah-ibadah-sai.ejs']) {
    const src = await fs.readFile(view, 'utf8');
    assert.match(src, /\/shared\/screen-wake-lock\.js/, `${view} loads wake-lock helper`);
    assert.match(src, /ScreenWakeLock\.acquire/, `${view} acquires on enter`);
    // pagehide release (covers bfcache too — unload would leak in bfcache)
    assert.match(src, /pagehide/, `${view} releases on pagehide`);
    assert.match(src, /ScreenWakeLock\.release/, `${view} explicit release call`);
  }
});

// ── S366 — App Badging ───────────────────────────────────────

test('S366 — /saya dashboard sets app badge from unreadCount', async () => {
  const src = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  assert.match(src, /navigator\.setAppBadge/);
  // Reads server-rendered unreadCount (no extra round-trip)
  assert.match(src, /unreadCount/);
  // Best-effort: feature-detects + swallows promise rejections
  assert.match(src, /typeof navigator\.setAppBadge !== 'function'/);
  // Clears when zero (rather than setting 0 which renders an empty dot)
  assert.match(src, /clearAppBadge/);
});

test('S366 — /saya/notifications clears app badge on visit', async () => {
  const src = await fs.readFile('./views/jemaah-notifications.ejs', 'utf8');
  assert.match(src, /navigator\.clearAppBadge/);
  // Feature-detects
  assert.match(src, /typeof navigator\.clearAppBadge !== 'function'/);
});
