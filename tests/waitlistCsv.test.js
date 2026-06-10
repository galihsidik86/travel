// Stage 174 — per-paket waitlist CSV export for offline outreach.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { buildWaitlistCsv } from '../src/services/waitlist.js';

test('buildWaitlistCsv: empty waitlist → header + footer only', async (t) => {
  const tag = makeTag('s174-empty');
  const paket = await tempPaket(t, tag);
  const r = await buildWaitlistCsv(paket.slug);
  assert.equal(r.rowCount, 0);
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM');
  assert.match(r.csv, /createdAt,status,fullName,phone/);
  assert.match(r.csv, /TOTAL/);
});

test('buildWaitlistCsv: covers all status types', async (t) => {
  const tag = makeTag('s174-statuses');
  const paket = await tempPaket(t, tag);
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Wait A', phone: '081111111111', status: 'WAITING' },
  });
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Prom B', phone: '081222222222', status: 'PROMOTED', promotedAt: new Date() },
  });
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Canc C', phone: '081333333333', status: 'CANCELLED', cancelledAt: new Date() },
  });
  t.after(async () => {
    await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await buildWaitlistCsv(paket.slug);
  assert.equal(r.rowCount, 3);
  assert.match(r.csv, /Wait A/);
  assert.match(r.csv, /Prom B/);
  assert.match(r.csv, /Canc C/);
  assert.match(r.csv, /WAITING/);
  assert.match(r.csv, /PROMOTED/);
  assert.match(r.csv, /CANCELLED/);
  // Counts in footer
  assert.equal(r.counts.waiting, 1);
  assert.equal(r.counts.promoted, 1);
  assert.equal(r.counts.cancelled, 1);
});

test('buildWaitlistCsv: special chars escaped (commas, quotes)', async (t) => {
  const tag = makeTag('s174-esc');
  const paket = await tempPaket(t, tag);
  await db.paketWaitlist.create({
    data: {
      paketId: paket.id,
      fullName: 'Ahmad, "the candidate"',
      phone: '+62 822-3399',
      status: 'WAITING',
      notes: 'Catatan dengan, koma',
    },
  });
  t.after(async () => {
    await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await buildWaitlistCsv(paket.slug);
  // Comma-bearing name wrapped in double-quotes + embedded quote escaped
  assert.match(r.csv, /"Ahmad, ""the candidate"""/);
  // Comma-bearing notes wrapped too
  assert.match(r.csv, /"Catatan dengan, koma"/);
});

test('buildWaitlistCsv: oldest-first ordering', async (t) => {
  const tag = makeTag('s174-order');
  const paket = await tempPaket(t, tag);
  await db.paketWaitlist.create({
    data: {
      paketId: paket.id, fullName: 'Z LATE', phone: '081999',
      status: 'WAITING', createdAt: new Date('2026-06-01'),
    },
  });
  await db.paketWaitlist.create({
    data: {
      paketId: paket.id, fullName: 'A EARLY', phone: '081888',
      status: 'WAITING', createdAt: new Date('2026-01-01'),
    },
  });
  t.after(async () => {
    await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await buildWaitlistCsv(paket.slug);
  const idxEarly = r.csv.indexOf('A EARLY');
  const idxLate = r.csv.indexOf('Z LATE');
  assert.ok(idxEarly < idxLate, 'oldest-first');
});
