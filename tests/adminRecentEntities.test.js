// Stage 255 — admin recently-viewed trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser } from './_helpers.js';
import {
  trackRecentEntity,
  getRecentEntities,
  MAX_RECENT,
} from '../src/services/adminRecentEntities.js';

test('MAX_RECENT exposed', () => {
  assert.equal(MAX_RECENT, 15);
});

test('getRecentEntities: empty for new user', async (t) => {
  const tag = makeTag('s255-empty');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const r = await getRecentEntities({ userId: u.id });
  assert.deepEqual(r, []);
});

test('trackRecentEntity: persists entry on User row', async (t) => {
  const tag = makeTag('s255-persist');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  await trackRecentEntity({
    userId: u.id, kind: 'booking', id: 'b1', label: 'RP-DEMO-0001',
  });

  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'booking');
  assert.equal(r[0].id, 'b1');
  assert.equal(r[0].label, 'RP-DEMO-0001');
});

test('trackRecentEntity: dedupes by (kind, id) — re-view shifts to top', async (t) => {
  const tag = makeTag('s255-dedupe');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  await trackRecentEntity({ userId: u.id, kind: 'booking', id: 'b1', label: 'first' });
  await trackRecentEntity({ userId: u.id, kind: 'booking', id: 'b2', label: 'middle' });
  await trackRecentEntity({ userId: u.id, kind: 'booking', id: 'b1', label: 'top now' });

  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r.length, 2);
  // b1 should be on top (most recently viewed)
  assert.equal(r[0].id, 'b1');
  assert.equal(r[0].label, 'top now'); // updated label
});

test('trackRecentEntity: caps at MAX_RECENT entries', async (t) => {
  const tag = makeTag('s255-cap');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  // Track 20 distinct bookings
  for (let i = 0; i < 20; i += 1) {
    await trackRecentEntity({
      userId: u.id, kind: 'booking', id: 'b' + i, label: 'B' + i,
    });
  }
  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r.length, MAX_RECENT);
  // Newest (b19) should be at top; oldest 5 evicted
  assert.equal(r[0].id, 'b19');
});

test('trackRecentEntity: silently ignores invalid kind', async (t) => {
  const tag = makeTag('s255-badkind');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  await trackRecentEntity({ userId: u.id, kind: 'invalid', id: 'x' });
  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r.length, 0);
});

test('trackRecentEntity: silently ignores missing id', async (t) => {
  const tag = makeTag('s255-noid');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await trackRecentEntity({ userId: u.id, kind: 'booking' });
  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r.length, 0);
});

test('trackRecentEntity: silent on unknown user (no error)', async () => {
  // Shouldn't throw
  await trackRecentEntity({
    userId: 'unknown-user', kind: 'paket', id: 'x',
  });
});

test('trackRecentEntity: clean caps label at 120 chars', async (t) => {
  const tag = makeTag('s255-clean');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const longLabel = 'A'.repeat(500);
  await trackRecentEntity({ userId: u.id, kind: 'jemaah', id: 'j1', label: longLabel });
  const r = await getRecentEntities({ userId: u.id });
  assert.equal(r[0].label.length, 120);
});

test('trackRecentEntity: viewedAt is an ISO date string', async (t) => {
  const tag = makeTag('s255-date');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await trackRecentEntity({ userId: u.id, kind: 'agen', id: 'a1' });
  const r = await getRecentEntities({ userId: u.id });
  assert.match(r[0].viewedAt, /^\d{4}-\d{2}-\d{2}T/);
});
