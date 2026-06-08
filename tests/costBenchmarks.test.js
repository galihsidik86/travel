import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempUser, fakeReq } from './_helpers.js';
import { addCostLine, getCostBenchmarks } from '../src/services/paketCostLines.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('getCostBenchmarks: empty when paket has no lines', async (t) => {
  const tag = makeTag('cb-empty');
  const p = await tempPaket(t, tag);
  const r = await getCostBenchmarks({ paketId: p.id });
  assert.deepEqual(r, []);
});

test('getCostBenchmarks: low sample (<3 peers) → flag null even if 10× off', async (t) => {
  const tag = makeTag('cb-low-n');
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const p1 = await tempPaket(t, `${tag}-1`);
  const p2 = await tempPaket(t, `${tag}-2`);

  await addCostLine({ req: fakeReq, actor: actor(a), paketId: p1.id, category: 'HOTEL', amountIdr: 100 });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: p2.id, category: 'HOTEL', amountIdr: 100_000 });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: { in: [p1.id, p2.id] } } });
  });

  // Only 2 paket in HOTEL → not enough for a flag.
  const r = await getCostBenchmarks({ paketId: p2.id });
  const hotel = r.find((x) => x.category === 'HOTEL');
  assert.ok(hotel);
  assert.equal(hotel.flag, null, 'low sample (n<3) suppresses flag');
});

test('getCostBenchmarks: flags `high` when 2x median', async (t) => {
  const tag = makeTag('cb-high');
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const peers = [];
  for (let i = 0; i < 4; i += 1) peers.push(await tempPaket(t, `${tag}-p${i}`));

  // 3 peers @ 10M HOTEL; the 4th is the outlier at 25M (2.5× median)
  for (let i = 0; i < 3; i += 1) {
    await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[i].id, category: 'HOTEL', amountIdr: 10_000_000 });
  }
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[3].id, category: 'HOTEL', amountIdr: 25_000_000 });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: { in: peers.map((p) => p.id) } } });
  });

  const r = await getCostBenchmarks({ paketId: peers[3].id });
  const hotel = r.find((x) => x.category === 'HOTEL');
  assert.ok(hotel);
  assert.equal(hotel.flag, 'high');
  assert.ok(hotel.deltaPct > 0);
});

test('getCostBenchmarks: flags `low` when half of median', async (t) => {
  const tag = makeTag('cb-low');
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const peers = [];
  for (let i = 0; i < 4; i += 1) peers.push(await tempPaket(t, `${tag}-p${i}`));

  // 3 peers @ 10M; outlier at 4M
  for (let i = 0; i < 3; i += 1) {
    await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[i].id, category: 'FLIGHT', amountIdr: 10_000_000 });
  }
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[3].id, category: 'FLIGHT', amountIdr: 4_000_000 });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: { in: peers.map((p) => p.id) } } });
  });

  const r = await getCostBenchmarks({ paketId: peers[3].id });
  const fl = r.find((x) => x.category === 'FLIGHT');
  assert.ok(fl);
  assert.equal(fl.flag, 'low');
  assert.ok(fl.deltaPct < 0);
});

test('getCostBenchmarks: within range → null flag', async (t) => {
  const tag = makeTag('cb-ok');
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const peers = [];
  for (let i = 0; i < 4; i += 1) peers.push(await tempPaket(t, `${tag}-p${i}`));

  for (let i = 0; i < 4; i += 1) {
    await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[i].id, category: 'VISA', amountIdr: 2_000_000 });
  }
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: { in: peers.map((p) => p.id) } } });
  });

  const r = await getCostBenchmarks({ paketId: peers[0].id });
  const visa = r.find((x) => x.category === 'VISA');
  assert.equal(visa.flag, null);
});

test('getCostBenchmarks: multi-line same category aggregated per-paket', async (t) => {
  const tag = makeTag('cb-multi');
  const a = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const peers = [];
  for (let i = 0; i < 3; i += 1) peers.push(await tempPaket(t, `${tag}-p${i}`));

  // Peers: 10M each via SINGLE line
  for (let i = 0; i < 3; i += 1) {
    await addCostLine({ req: fakeReq, actor: actor(a), paketId: peers[i].id, category: 'HOTEL', amountIdr: 10_000_000 });
  }
  // Outlier: 3 lines totalling 30M = 3× median → flagged 'high'
  const outlier = await tempPaket(t, `${tag}-out`);
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: outlier.id, category: 'HOTEL', amountIdr: 10_000_000, vendorNote: 'Madinah' });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: outlier.id, category: 'HOTEL', amountIdr: 10_000_000, vendorNote: 'Mekkah' });
  await addCostLine({ req: fakeReq, actor: actor(a), paketId: outlier.id, category: 'HOTEL', amountIdr: 10_000_000, vendorNote: 'Aqsa' });
  t.after(async () => {
    await db.paketCostLine.deleteMany({ where: { paketId: { in: [...peers, outlier].map((p) => p.id) } } });
  });

  const r = await getCostBenchmarks({ paketId: outlier.id });
  const hotel = r.find((x) => x.category === 'HOTEL');
  assert.equal(hotel.amount, 30_000_000, 'aggregated per-paket total');
  assert.equal(hotel.flag, 'high', 'multi-line sum still triggers flag');
});
