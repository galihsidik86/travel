// Stage 367-369 — PWA safety + durability:
//   S367 Persistent Storage opt-in
//   S368 Crew offline incident queue
//   S369 Crew SOS shortcut

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

// ── S367 — Persistent Storage opt-in ─────────────────────────

test('S367 — persist-storage.js exposes request/status API', async () => {
  const src = await fs.readFile('./shared/persist-storage.js', 'utf8');
  // Helper assigns to global.PersistStorage where global = window
  assert.match(src, /global\.PersistStorage|window\.PersistStorage/);
  assert.match(src, /navigator\.storage\.persist/);
  assert.match(src, /navigator\.storage\.persisted/);
  // Single-flight guard so concurrent triggers don't race
  assert.match(src, /pending/);
  // One-shot per session via localStorage flag
  assert.match(src, /rp_persist_asked/);
});

test('S367 — SOS submit + ibadah counters + attendance form all opt in', async () => {
  // Jemaah SOS in /saya
  const portal = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  assert.match(portal, /\/shared\/persist-storage\.js/);
  assert.match(portal, /PersistStorage\.request\(\{ reason: 'sos' \}\)/);

  // Thawaf + Sa'i ibadah pages
  for (const v of ['./views/jemaah-ibadah-thawaf.ejs', './views/jemaah-ibadah-sai.ejs']) {
    const src = await fs.readFile(v, 'utf8');
    assert.match(src, /\/shared\/persist-storage\.js/, `${v} loads helper`);
    assert.match(src, /PersistStorage\.request\(\{ reason: 'ibadah' \}\)/, `${v} opts in on tap`);
  }

  // Crew attendance form
  const att = await fs.readFile('./views/crew-attendance-day.ejs', 'utf8');
  assert.match(att, /\/shared\/persist-storage\.js/);
  assert.match(att, /PersistStorage\.request\(\{ reason: 'attendance' \}\)/);
});

// ── S368 — Crew offline incident queue ───────────────────────

test('S368 — crew-incident-queue.js exposes IDB queue with auto-flush', async () => {
  const src = await fs.readFile('./shared/crew-incident-queue.js', 'utf8');
  assert.match(src, /window\.CrewIncidentQueue/);
  assert.match(src, /enqueue/);
  assert.match(src, /drain/);
  assert.match(src, /startAutoFlush/);
  // Distinct IDB DB from S355 SOS-light store
  assert.match(src, /religio-crew-incidents/);
  // Form-encoded POST (matches /crew/sos shape)
  assert.match(src, /application\/x-www-form-urlencoded/);
  // 429 (SOS_THROTTLED) treated as success on replay (server-side dupe collapse)
  assert.match(src, /429/);
});

test('S368 — sos-fab partial intercepts submit + queues on offline', async () => {
  const src = await fs.readFile('./views/partials/sos-fab.ejs', 'utf8');
  assert.match(src, /\/shared\/crew-incident-queue\.js/);
  // navigator.onLine === false → queue immediately
  assert.match(src, /navigator\.onLine === false/);
  assert.match(src, /CrewIncidentQueue\.enqueue/);
  // Auto-flush + queued badge on FAB
  assert.match(src, /startAutoFlush/);
  assert.match(src, /sos-fab__queued/);
});

// ── S369 — Crew SOS shortcut ─────────────────────────────────

test('S369 — manifest-crew declares SOS Crew as FIRST shortcut', async () => {
  const src = await fs.readFile('./shared/manifest-crew.webmanifest', 'utf8');
  const manifest = JSON.parse(src);
  assert.ok(Array.isArray(manifest.shortcuts));
  assert.match(manifest.shortcuts[0].name, /sos/i, 'SOS Crew is first shortcut');
  assert.equal(manifest.shortcuts[0].url, '/crew?sos=1');
});

test('S369 — sos-fab partial auto-opens modal when ?sos=1 query present', async () => {
  const src = await fs.readFile('./views/partials/sos-fab.ejs', 'utf8');
  assert.match(src, /URLSearchParams/);
  assert.match(src, /'sos'/);
  assert.match(src, /showModal\(\)/);
  // Strips ?sos=1 so reload doesn't keep re-firing the modal
  assert.match(src, /history\.replaceState/);
});
