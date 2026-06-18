// Stage 333 — doa harian client-side asset shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';

async function loadDoaModule() {
  const src = await fs.readFile('./shared/doa-harian.js', 'utf8');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.DoaHarian;
}

test('S333 — DoaHarian exposed on window with all/getTodayDoa', async () => {
  const D = await loadDoaModule();
  assert.ok(D, 'DoaHarian present');
  assert.ok(Array.isArray(D.all));
  assert.ok(D.all.length >= 10, 'at least 10 doa in rotation');
  assert.equal(typeof D.getTodayDoa, 'function');
});

test('S333 — getTodayDoa returns a doa with title/arabic/latin/translation', async () => {
  const D = await loadDoaModule();
  const d = D.getTodayDoa(new Date('2026-06-18'));
  assert.ok(d);
  assert.ok(d.title);
  assert.ok(d.arabic);
  assert.ok(d.latin);
  assert.ok(d.translation);
});

test('S333 — cycle modulo total covers all entries across the year', async () => {
  const D = await loadDoaModule();
  const seenTitles = new Set();
  for (let day = 0; day < 366; day++) {
    const d = new Date(2026, 0, 1);
    d.setDate(d.getDate() + day);
    const doa = D.getTodayDoa(d);
    seenTitles.add(doa.title);
  }
  assert.equal(seenTitles.size, D.all.length, 'every doa appears at least once across a year');
});
