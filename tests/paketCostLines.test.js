import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempUser, fakeReq } from './_helpers.js';
import {
  addCostLine, updateCostLine, deleteCostLine,
  listCostLines, getCostByCategoryAcrossPaket,
} from '../src/services/paketCostLines.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('addCostLine: rejects bad category', async (t) => {
  const tag = makeTag('cl-bad-cat');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  await assert.rejects(
    () => addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'BOGUS', amountIdr: 100 }),
    (err) => err instanceof HttpError && err.code === 'BAD_CATEGORY',
  );
});

test('addCostLine: rejects negative amount', async (t) => {
  const tag = makeTag('cl-bad-amt');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  await assert.rejects(
    () => addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: -1 }),
    (err) => err instanceof HttpError && err.code === 'BAD_AMOUNT',
  );
});

test('addCostLine: first line auto-syncs costPerPaxIdr', async (t) => {
  const tag = makeTag('cl-sync');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await addCostLine({
    req: fakeReq, actor: actor(a),
    paketId: paket.id, category: 'HOTEL', amountIdr: 12_000_000, vendorNote: 'Hilton Madinah',
  });
  assert.equal(r.newTotal, 12_000_000);

  const p = await db.paket.findUnique({ where: { id: paket.id }, select: { costPerPaxIdr: true } });
  assert.equal(Number(p.costPerPaxIdr.toString()), 12_000_000);
});

test('addCostLine: subsequent lines accumulate into total', async (t) => {
  const tag = makeTag('cl-accum');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: paket.id } });
  });

  await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: 10_000_000 });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'FLIGHT', amountIdr: 8_000_000 });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'VISA', amountIdr: 2_000_000 });

  const p = await db.paket.findUnique({ where: { id: paket.id }, select: { costPerPaxIdr: true } });
  assert.equal(Number(p.costPerPaxIdr.toString()), 20_000_000);

  const lines = await listCostLines(paket.id);
  assert.equal(lines.length, 3);
});

test('deleteCostLine: removes line, recomputes total', async (t) => {
  const tag = makeTag('cl-del');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: paket.id } });
  });

  const l1 = await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: 10 });
  const l2 = await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'FLIGHT', amountIdr: 20 });

  const after = await deleteCostLine({ req: fakeReq, actor: actor(a), id: l1.line.id });
  assert.equal(after.newTotal, 20, 'remaining line total = 20');
});

test('deleteCostLine: deleting last line does NOT clear costPerPaxIdr (preserves manual estimate path)', async (t) => {
  const tag = makeTag('cl-del-last');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  const l = await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: 5_000_000 });
  // costPerPaxIdr is now 5_000_000 via auto-sync.
  await deleteCostLine({ req: fakeReq, actor: actor(a), id: l.line.id });

  const p = await db.paket.findUnique({ where: { id: paket.id }, select: { costPerPaxIdr: true } });
  // Per the design comment: when last line is removed, column NOT cleared.
  assert.equal(Number(p.costPerPaxIdr.toString()), 5_000_000, 'last delete preserves prior sum');
});

test('updateCostLine: recomputes total when amount changes', async (t) => {
  const tag = makeTag('cl-upd');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: paket.id } });
  });

  const l = await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: 10 });
  await updateCostLine({ req: fakeReq, actor: actor(a), id: l.line.id, amountIdr: 30 });

  const p = await db.paket.findUnique({ where: { id: paket.id }, select: { costPerPaxIdr: true } });
  assert.equal(Number(p.costPerPaxIdr.toString()), 30);
});

test('getCostByCategoryAcrossPaket: aggregates + sorts by amount desc', async (t) => {
  const tag = makeTag('cl-agg');
  const paket = await tempPaket(t, tag);
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: paket.id } });
  });

  await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'HOTEL', amountIdr: 100 });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: paket.id, category: 'FLIGHT', amountIdr: 200 });

  const rollup = await getCostByCategoryAcrossPaket();
  const hotel = rollup.find((r) => r.category === 'HOTEL');
  const flight = rollup.find((r) => r.category === 'FLIGHT');
  assert.ok(hotel && flight);
  // FLIGHT > HOTEL in our test data → should come first regardless of seed
  const flightIdx = rollup.findIndex((r) => r.category === 'FLIGHT');
  const hotelIdx = rollup.findIndex((r) => r.category === 'HOTEL');
  // ...within categories that include our amounts, but other tests may
  // have added rows too. Just verify both present + sorted desc.
  assert.ok(rollup.length >= 2);
  for (let i = 1; i < rollup.length; i++) {
    assert.ok(rollup[i - 1].amountIdr >= rollup[i].amountIdr, 'sorted desc');
  }
});
