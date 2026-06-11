// Stage 196 — per-paket pickup points CRUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import {
  listPickups, createPickup, updatePickup, deletePickup,
} from '../src/services/paketPickups.js';

test('listPickups: empty paket → []', async (t) => {
  const tag = makeTag('s196-empty');
  const paket = await tempPaket(t, tag);
  const r = await listPickups(paket.id);
  assert.equal(r.length, 0);
});

test('createPickup: writes row + audit', async (t) => {
  const tag = makeTag('s196-create');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketPickup' } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });
  const r = await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'Bekasi', address: 'Jl. Ahmad Yani No.1, Bekasi', departTime: '05:00', sortOrder: 1 },
  });
  assert.equal(r.label, 'Bekasi');
  assert.equal(r.departTime, '05:00');
  assert.equal(r.sortOrder, 1);

  const audits = await db.auditLog.findMany({
    where: { entity: 'PaketPickup', action: 'CREATE' },
  });
  assert.ok(audits.length >= 1);
});

test('createPickup: rejects too-short label', async (t) => {
  const tag = makeTag('s196-validate');
  const paket = await tempPaket(t, tag);
  await assert.rejects(
    createPickup({
      req: fakeReq, actor: systemActor, paketId: paket.id,
      input: { label: 'X', address: 'Valid alamat panjang' },
    }),
    /minimal 2/,
  );
});

test('createPickup: unknown paketId → PAKET_NOT_FOUND', async () => {
  await assert.rejects(
    createPickup({
      req: fakeReq, actor: systemActor, paketId: 'does-not-exist',
      input: { label: 'BL', address: 'valid alamat' },
    }),
    /PAKET_NOT_FOUND|tidak ditemukan/,
  );
});

test('createPickup: empty departTime stored as null', async (t) => {
  const tag = makeTag('s196-empty-time');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
    await db.auditLog.deleteMany({ where: { entity: 'PaketPickup' } });
  });
  const r = await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'Bogor', address: 'Jl. Pajajaran', departTime: '' },
  });
  assert.equal(r.departTime, null);
});

test('listPickups: sorted by sortOrder asc + createdAt asc', async (t) => {
  const tag = makeTag('s196-sort');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketPickup' } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });
  await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'Z late', address: 'addr Z', sortOrder: 9 },
  });
  await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'A early', address: 'addr A', sortOrder: 1 },
  });
  await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'M middle', address: 'addr M', sortOrder: 1 },
  });
  const rows = await listPickups(paket.id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'A early', 'lowest sort first');
  assert.equal(rows[1].label, 'M middle', 'same sort → createdAt order');
  assert.equal(rows[2].label, 'Z late');
});

test('updatePickup: changes fields + audit diff', async (t) => {
  const tag = makeTag('s196-update');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketPickup' } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });
  const created = await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'BX1', address: 'Old address' },
  });
  await updatePickup({
    req: fakeReq, actor: systemActor, id: created.id,
    input: { label: 'BX1 updated', address: 'New address', departTime: '06:00' },
  });
  const row = await db.paketPickup.findUnique({ where: { id: created.id } });
  assert.equal(row.label, 'BX1 updated');
  assert.equal(row.departTime, '06:00');
});

test('updatePickup: unknown id → PICKUP_NOT_FOUND', async () => {
  await assert.rejects(
    updatePickup({
      req: fakeReq, actor: systemActor, id: 'does-not-exist',
      input: { label: 'BX', address: 'valid alamat' },
    }),
    /PICKUP_NOT_FOUND|tidak ditemukan/,
  );
});

test('deletePickup: removes row + writes DELETE audit', async (t) => {
  const tag = makeTag('s196-delete');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketPickup' } });
  });
  const created = await createPickup({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { label: 'BX', address: 'valid alamat' },
  });
  await deletePickup({ req: fakeReq, actor: systemActor, id: created.id });
  const row = await db.paketPickup.findUnique({ where: { id: created.id } });
  assert.equal(row, null);
});
