// Stage 361-363 — PWA gap closure: crew offline contacts,
// SW update prompt, SOS shortcut.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

// ── S361 — crew offline contacts ──────────────────────────────

test('S361 — sw.js adds /crew/contacts to SWR prefix list', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  assert.match(src, /SWR_PATH_PREFIXES = \[[^\]]*\/crew\/contacts/);
  // Version bumped past v6 (S352 baseline) so installed clients pick up
  // the new SWR scope on next activation.
  assert.match(src, /rp-v(?:[7-9]|\d{2,})/);
});

test('S361 — crew-contacts.ejs renders last-synced badge + offline warning', async () => {
  const src = await fs.readFile('./views/crew-contacts.ejs', 'utf8');
  assert.match(src, /rp-contacts-sync/);
  assert.match(src, /rp_crew_contacts_last_sync/);
  // Online → write timestamp; offline → render warning
  assert.match(src, /navigator\.onLine/);
  assert.match(src, /OFFLINE/);
  assert.match(src, /Sinkron/i);
});

// ── S362 — SW update prompt ──────────────────────────────────

test('S362 — pwa.js wires controllerchange handler + update banner', async () => {
  const src = await fs.readFile('./shared/pwa.js', 'utf8');
  assert.match(src, /controllerchange/);
  assert.match(src, /showSwUpdateBanner/);
  // Guards against first-install firing the banner spuriously
  assert.match(src, /hadController/);
  // Banner DOM contract + dedup
  assert.match(src, /rp-sw-update/);
  // Refresh action triggers full reload
  assert.match(src, /window\.location\.reload\(\)/);
});

// ── S363 — SOS shortcut ──────────────────────────────────────

test('S363 — manifest-jemaah declares SOS Cepat shortcut', async () => {
  const src = await fs.readFile('./shared/manifest-jemaah.webmanifest', 'utf8');
  const manifest = JSON.parse(src);
  assert.ok(Array.isArray(manifest.shortcuts), 'shortcuts present');
  const sos = manifest.shortcuts.find((s) => /sos/i.test(s.name));
  assert.ok(sos, 'SOS Cepat shortcut declared');
  assert.equal(sos.url, '/saya?sos=1');
  assert.match(sos.short_name, /sos/i);
});

test('S363 — /saya auto-opens SOS form when ?sos=1 query present', async () => {
  const src = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  // Reads the sos param + clicks the toggle if present
  assert.match(src, /URLSearchParams/);
  assert.match(src, /'sos'/);
  assert.match(src, /toggle\.click\(\)/);
  // Strips ?sos=1 from URL after open so reload doesn't keep re-firing
  assert.match(src, /history\.replaceState/);
});

test('S363 — SOS shortcut is FIRST in manifest shortcuts (most prominent in long-press)', async () => {
  const src = await fs.readFile('./shared/manifest-jemaah.webmanifest', 'utf8');
  const manifest = JSON.parse(src);
  // First shortcut shown at top of long-press menu — SOS needs that slot
  assert.match(manifest.shortcuts[0].name, /sos/i, 'SOS is first shortcut');
});
