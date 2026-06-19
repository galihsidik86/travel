// Stage 334 — SW shape test. Verifies stale-while-revalidate is wired
// for /saya paths + cache cap helper exists + version bump happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

test('S334 — sw.js bumped past v4 + SWR helpers defined', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  // Version may have bumped further (S352 → v6); just assert >= v5.
  assert.match(src, /rp-v(?:[5-9]|\d{2,})/, 'CACHE_VERSION at v5 or higher');
  assert.match(src, /handleSwr/, 'SWR handler defined');
  assert.match(src, /handleNetworkFirst/, 'network-first handler defined');
  assert.match(src, /capHtmlCache/, 'cache cap helper defined');
  assert.match(src, /HTML_CACHE_MAX/, 'cache max constant defined');
  assert.match(src, /X-SW-Cache/, 'cache-hit response header defined');
});

test('S334 — SWR scope covers /saya/bookings/ + /saya/ibadah', async () => {
  const src = await fs.readFile('./shared/sw.js', 'utf8');
  assert.match(src, /\/saya\/bookings\//);
  assert.match(src, /\/saya\/ibadah/);
});
