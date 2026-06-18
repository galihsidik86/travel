// Stage 327 — per-role PWA manifest. Pure file + view-render shape test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import ejs from 'ejs';

test('S327 — manifest-jemaah.webmanifest valid JSON with scope=/saya', async () => {
  const raw = await fs.readFile('./shared/manifest-jemaah.webmanifest', 'utf8');
  const json = JSON.parse(raw);
  assert.equal(json.scope, '/saya');
  assert.equal(json.start_url, '/saya');
  assert.match(json.name, /Jemaah/);
});

test('S327 — manifest-crew.webmanifest valid JSON with scope=/crew', async () => {
  const raw = await fs.readFile('./shared/manifest-crew.webmanifest', 'utf8');
  const json = JSON.parse(raw);
  assert.equal(json.scope, '/crew');
  assert.equal(json.start_url, '/crew');
  assert.match(json.name, /Crew/);
  // Crew has a dedicated incident shortcut
  const incidentShortcut = (json.shortcuts || []).find((s) => s.url === '/crew/incidents');
  assert.ok(incidentShortcut, 'crew manifest has incident shortcut');
});

test('S327 — pwa-head default (no pwaRole) picks jemaah manifest', async () => {
  const html = await ejs.renderFile('./views/partials/pwa-head.ejs', {});
  assert.match(html, /\/shared\/manifest-jemaah\.webmanifest/);
  assert.doesNotMatch(html, /manifest-crew/);
});

test('S327 — pwa-head with pwaRole=crew picks crew manifest + theme', async () => {
  const html = await ejs.renderFile('./views/partials/pwa-head.ejs', { pwaRole: 'crew' });
  assert.match(html, /\/shared\/manifest-crew\.webmanifest/);
  assert.match(html, /content="#D4AF6B"/);
  assert.match(html, /Religio Crew/);
});

test('S327 — pwa-head with invalid pwaRole falls back to jemaah', async () => {
  const html = await ejs.renderFile('./views/partials/pwa-head.ejs', { pwaRole: 'nonsense' });
  assert.match(html, /manifest-jemaah/);
});
