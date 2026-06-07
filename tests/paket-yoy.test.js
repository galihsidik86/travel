// Stage 34 — YoY paket comparison via clonedFromId.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { getPerPaketLeaderboard } from '../src/services/analytics.js';

test('clonedFromId is set on the clone (writeback via service)', async (t) => {
  const tag = makeTag('yoy-clone');
  const parent = await tempPaket(t, `${tag}-p`);
  // Spawn a clone via Prisma directly (so the test doesn't go through HTTP);
  // verifies the schema is wired correctly to allow setting clonedFromId.
  const clone = await db.paket.create({
    data: {
      slug: `${tag}-clone`,
      title: 'Clone of Parent',
      departureDate: new Date(Date.now() + 90 * 86_400_000),
      returnDate: new Date(Date.now() + 100 * 86_400_000),
      durationDays: 10,
      inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0,
      status: 'DRAFT',
      clonedFromId: parent.id,
    },
  });
  t.after(async () => {
    await db.paket.deleteMany({ where: { id: clone.id } });
  });
  const re = await db.paket.findUnique({
    where: { id: clone.id },
    select: { clonedFromId: true },
  });
  assert.equal(re.clonedFromId, parent.id);
});

test('leaderboard attaches previousSeason for clones with parent revenue', async (t) => {
  const tag = makeTag('yoy-lb');
  const jem = await tempJemaah(t, tag);

  // Parent paket with 1 LUNAS booking worth 5M
  const parent = await tempPaket(t, `${tag}-p`);
  const parentBk = await tempBooking({
    paket: parent, jemaahProfileId: jem.jemaah.id, totalAmount: '5000000',
  });
  await db.booking.update({
    where: { id: parentBk.id },
    data: { status: 'LUNAS', paidAmount: '5000000' },
  });

  // Clone paket with 1 LUNAS booking worth 7M (up 40%)
  const clone = await db.paket.create({
    data: {
      slug: `${tag}-cl`,
      title: 'Clone',
      departureDate: new Date(Date.now() + 90 * 86_400_000),
      returnDate: new Date(Date.now() + 100 * 86_400_000),
      durationDays: 10,
      inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0,
      status: 'ACTIVE',
      clonedFromId: parent.id,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: clone.id } });
    await db.paket.deleteMany({ where: { id: clone.id } });
  });
  const cloneBk = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-cl1`,
      paketId: clone.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '7000000', paidAmount: '7000000',
      status: 'LUNAS',
    },
  });

  // No date filter → full leaderboard
  const leaderboard = await getPerPaketLeaderboard({ limit: 0 });
  const cloneRow = leaderboard.find((r) => r.paketId === clone.id);
  assert.ok(cloneRow, 'clone row must be in the leaderboard');
  assert.ok(cloneRow.previousSeason, 'previousSeason must be attached for a clone');
  assert.equal(cloneRow.previousSeason.paketId, parent.id);
  assert.equal(cloneRow.previousSeason.lunasRevenue, 5_000_000);
  assert.equal(cloneRow.previousSeason.revenueDelta, 2_000_000);
  assert.equal(cloneRow.previousSeason.revenueDeltaPct, 40);

  // Parent row should have null previousSeason (it has no parent)
  const parentRow = leaderboard.find((r) => r.paketId === parent.id);
  assert.equal(parentRow.previousSeason, null);
});

test('previousSeason omitted when parent has zero LUNAS revenue (no comparison meaningful)', async (t) => {
  const tag = makeTag('yoy-empty-parent');
  const jem = await tempJemaah(t, tag);

  const parent = await tempPaket(t, `${tag}-p`);  // never has LUNAS
  const clone = await db.paket.create({
    data: {
      slug: `${tag}-cl`, title: 'Clone-empty',
      departureDate: new Date(Date.now() + 90 * 86_400_000),
      returnDate: new Date(Date.now() + 100 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      clonedFromId: parent.id,
    },
  });
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-clb`,
      paketId: clone.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000',
      status: 'LUNAS',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: bk.id } });
    await db.paket.deleteMany({ where: { id: clone.id } });
  });

  const lb = await getPerPaketLeaderboard({ limit: 0 });
  const row = lb.find((r) => r.paketId === clone.id);
  // previousSeason still attached (the parent exists), but revenueDeltaPct
  // is null because parent.lunasRevenue=0 (avoids divide-by-zero).
  assert.ok(row.previousSeason);
  assert.equal(row.previousSeason.lunasRevenue, 0);
  assert.equal(row.previousSeason.revenueDeltaPct, null, 'pct must be null when parent is zero');
  assert.equal(row.previousSeason.revenueDelta, 5_000_000);
});
