// Stage 328-330 — Ibadah routes render. Pure view smoke (no backend logic
// — the counters are client-side IDB).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { promises as fs } from 'node:fs';

test('S330 — jemaah-ibadah-hub view renders with both counter links', async () => {
  const html = await ejs.renderFile('./views/jemaah-ibadah-hub.ejs', { user: { fullName: 'Test', email: 't@t' } });
  assert.match(html, /\/saya\/ibadah\/thawaf/);
  assert.match(html, /\/saya\/ibadah\/sai/);
  assert.match(html, /Penghitung/);
  assert.match(html, /ibadah-counter\.js/);
});

test('S328 — thawaf view renders with counter card + IDB script', async () => {
  const html = await ejs.renderFile('./views/jemaah-ibadah-thawaf.ejs', { user: { fullName: 'Test', email: 't@t' } });
  assert.match(html, /Thawaf/);
  assert.match(html, /Hajar Aswad/);
  assert.match(html, /ibadah-counter\.js/);
  // 7-putaran max
  assert.match(html, /\/7/);
});

test('S329 — sai view renders with Safa/Marwah markers', async () => {
  const html = await ejs.renderFile('./views/jemaah-ibadah-sai.ejs', { user: { fullName: 'Test', email: 't@t' } });
  assert.match(html, /Sa'i/);
  assert.match(html, /Safa/);
  assert.match(html, /Marwah/);
  assert.match(html, /ibadah-counter\.js/);
});

test('S328 — shared/ibadah-counter.js exports IbadahCounter on window', async () => {
  const raw = await fs.readFile('./shared/ibadah-counter.js', 'utf8');
  // Surface contract: global.IbadahCounter with getCounter/tap/reset/undo
  assert.match(raw, /global\.IbadahCounter\s*=/);
  assert.match(raw, /getCounter/);
  assert.match(raw, /tap/);
  assert.match(raw, /reset/);
  assert.match(raw, /undo/);
});
