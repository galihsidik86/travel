// Stage 283 — PaketAddon catalog CRUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket } from './_helpers.js';
import {
  listPaketAddons,
  createPaketAddon,
  updatePaketAddon,
  deletePaketAddon,
} from '../src/services/paketAddons.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('createPaketAddon: 404 on unknown paket', async () => {
  await assert.rejects(
    () => createPaketAddon({
      req: ownerReq, actor: ownerActor,
      paketSlug: 'nope-xxx',
      input: { name: 'Extra baggage', priceIdr: 500000 },
    }),
    (err) => err.code === 'PAKET_NOT_FOUND' && err.status === 404,
  );
});

test('createPaketAddon: 400 on missing/short name', async (t) => {
  const paket = await tempPaket(t, 'pa-name');
  await assert.rejects(
    () => createPaketAddon({
      req: ownerReq, actor: ownerActor,
      paketSlug: paket.slug,
      input: { name: 'X', priceIdr: 500000 },
    }),
    (err) => err.code === 'ADDON_NAME_REQUIRED' && err.status === 400,
  );
});

test('createPaketAddon: 400 on bad price (negative or non-numeric)', async (t) => {
  const paket = await tempPaket(t, 'pa-price');
  await assert.rejects(
    () => createPaketAddon({
      req: ownerReq, actor: ownerActor,
      paketSlug: paket.slug,
      input: { name: 'Extra baggage 30kg', priceIdr: -100 },
    }),
    (err) => err.code === 'ADDON_BAD_PRICE' && err.status === 400,
  );
  await assert.rejects(
    () => createPaketAddon({
      req: ownerReq, actor: ownerActor,
      paketSlug: paket.slug,
      input: { name: 'Extra baggage 30kg', priceIdr: 'abc' },
    }),
    (err) => err.code === 'ADDON_BAD_PRICE' && err.status === 400,
  );
});

test('createPaketAddon: persists + isActive defaults true + sortOrder bumps', async (t) => {
  const paket = await tempPaket(t, 'pa-create');
  const a1 = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Extra baggage 30kg', priceIdr: 500000 },
  });
  assert.equal(a1.name, 'Extra baggage 30kg');
  assert.equal(Number(a1.priceIdr.toString()), 500000);
  assert.equal(a1.isActive, true);
  // sortOrder defaults to (max+10) → 0 + 10 = 10 on first row
  assert.equal(a1.sortOrder, 10);

  const a2 = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Room upgrade', priceIdr: 2000000 },
  });
  assert.equal(a2.sortOrder, 20, 'second row sortOrder bumped beyond first');
});

test('listPaketAddons: returns all by default', async (t) => {
  const paket = await tempPaket(t, 'pa-list');
  await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Active addon', priceIdr: 100000 },
  });
  const inactive = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Inactive addon', priceIdr: 100000, isActive: false },
  });
  const all = await listPaketAddons(paket.id);
  assert.equal(all.length, 2);
  const onlyActive = await listPaketAddons(paket.id, { activeOnly: true });
  assert.equal(onlyActive.length, 1);
  assert.ok(!onlyActive.find((a) => a.id === inactive.id));
});

test('updatePaketAddon: 404 on unknown id', async () => {
  await assert.rejects(
    () => updatePaketAddon({
      req: ownerReq, actor: ownerActor,
      addonId: 'cknotexist', input: { name: 'new name' },
    }),
    (err) => err.code === 'ADDON_NOT_FOUND' && err.status === 404,
  );
});

test('updatePaketAddon: partial update writes only changed fields', async (t) => {
  const paket = await tempPaket(t, 'pa-update');
  const a = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Original', priceIdr: 100000 },
  });
  const r = await updatePaketAddon({
    req: ownerReq, actor: ownerActor,
    addonId: a.id, input: { priceIdr: 200000 },
  });
  assert.equal(r.updated, true);
  assert.equal(Number(r.addon.priceIdr.toString()), 200000);
  assert.equal(r.addon.name, 'Original', 'name preserved');
});

test('updatePaketAddon: no-op when nothing changed (skip-audit)', async (t) => {
  const paket = await tempPaket(t, 'pa-noop');
  const a = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Same', priceIdr: 100000 },
  });
  const beforeCount = await db.auditLog.count({
    where: { entity: 'PaketAddon', entityId: a.id, action: 'UPDATE' },
  });
  const r = await updatePaketAddon({
    req: ownerReq, actor: ownerActor,
    addonId: a.id, input: { name: 'Same', priceIdr: 100000 },
  });
  assert.equal(r.updated, false);
  const afterCount = await db.auditLog.count({
    where: { entity: 'PaketAddon', entityId: a.id, action: 'UPDATE' },
  });
  assert.equal(beforeCount, afterCount, 'no audit row written');
});

test('updatePaketAddon: isActive toggle', async (t) => {
  const paket = await tempPaket(t, 'pa-active');
  const a = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Toggle me', priceIdr: 100000 },
  });
  const r = await updatePaketAddon({
    req: ownerReq, actor: ownerActor,
    addonId: a.id, input: { isActive: false },
  });
  assert.equal(r.updated, true);
  assert.equal(r.addon.isActive, false);
});

test('deletePaketAddon: removes row', async (t) => {
  const paket = await tempPaket(t, 'pa-del');
  const a = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Delete me', priceIdr: 100000 },
  });
  const r = await deletePaketAddon({
    req: ownerReq, actor: ownerActor, addonId: a.id,
  });
  assert.equal(r.deleted, true);
  const after = await db.paketAddon.findUnique({ where: { id: a.id } });
  assert.equal(after, null);
});

test('deletePaketAddon: 404 on unknown id', async () => {
  await assert.rejects(
    () => deletePaketAddon({
      req: ownerReq, actor: ownerActor, addonId: 'cknotexist',
    }),
    (err) => err.code === 'ADDON_NOT_FOUND' && err.status === 404,
  );
});
