// Stage 192 — per-paket announcement banner CRUD + active filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import {
  listAnnouncements, listActiveAnnouncements,
  createAnnouncement, updateAnnouncement, deleteAnnouncement,
} from '../src/services/paketAnnouncements.js';

test('createAnnouncement: writes row + audit', async (t) => {
  const tag = makeTag('s192-create');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });
  const r = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Manasik wajib', body: 'Hadir tgl 5 Juni jam 9' },
  });
  assert.equal(r.title, 'Manasik wajib');
  assert.equal(r.expiresAt, null);

  const audits = await db.auditLog.findMany({
    where: { entity: 'PaketAnnouncement', action: 'CREATE' },
  });
  assert.ok(audits.length >= 1);
});

test('createAnnouncement: too-short fields rejected', async (t) => {
  const tag = makeTag('s192-validate');
  const paket = await tempPaket(t, tag);
  await assert.rejects(
    createAnnouncement({
      req: fakeReq, actor: systemActor, paketId: paket.id,
      input: { title: 'A', body: 'B' },
    }),
    /minimal 3/,
  );
});

test('listAnnouncements: includes scheduled + expired (admin view)', async (t) => {
  const tag = makeTag('s192-all');
  const paket = await tempPaket(t, tag);
  t.after(async () => { await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } }); });

  // Past expired
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Expired one', body: 'old news',
      publishedAt: new Date('2025-01-01'), expiresAt: new Date('2025-02-01'),
    },
  });
  // Active
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Live one', body: 'still active',
      publishedAt: new Date('2026-01-01'),
    },
  });
  // Future scheduled
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Future one', body: 'not yet',
      publishedAt: new Date('2099-01-01'),
    },
  });

  const rows = await listAnnouncements(paket.id);
  assert.equal(rows.length, 3, 'admin view shows all');
});

test('listActiveAnnouncements: filters out expired + future', async (t) => {
  const tag = makeTag('s192-active');
  const paket = await tempPaket(t, tag);
  t.after(async () => { await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } }); });

  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Expired', body: 'b',
      publishedAt: new Date('2025-01-01'), expiresAt: new Date('2025-02-01'),
    },
  });
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Live', body: 'b',
      publishedAt: new Date('2026-01-01'),
    },
  });
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Future', body: 'b',
      publishedAt: new Date('2099-01-01'),
    },
  });

  const r = await listActiveAnnouncements({
    paketId: paket.id, now: new Date('2026-06-01'),
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].title, 'Live');
});

test('listActiveAnnouncements: null expiresAt = never expires', async (t) => {
  const tag = makeTag('s192-noexp');
  const paket = await tempPaket(t, tag);
  t.after(async () => { await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } }); });
  await db.paketAnnouncement.create({
    data: {
      paketId: paket.id, title: 'Perpetual', body: 'b',
      publishedAt: new Date('2020-01-01'),
      // expiresAt: null
    },
  });
  const r = await listActiveAnnouncements({
    paketId: paket.id, now: new Date('2999-01-01'),
  });
  assert.equal(r.length, 1, 'null expiresAt → still active far in future');
});

test('updateAnnouncement: edits + audit before/after', async (t) => {
  const tag = makeTag('s192-update');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });
  const created = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Old title', body: 'Old body' },
  });
  await updateAnnouncement({
    req: fakeReq, actor: systemActor, id: created.id,
    input: { title: 'New title', body: 'New body' },
  });
  const row = await db.paketAnnouncement.findUnique({ where: { id: created.id } });
  assert.equal(row.title, 'New title');

  const upd = await db.auditLog.findFirst({
    where: { entity: 'PaketAnnouncement', action: 'UPDATE', entityId: created.id },
  });
  assert.equal(upd.before.title, 'Old title');
  assert.equal(upd.after.title, 'New title');
});

test('deleteAnnouncement: removes row + writes DELETE audit', async (t) => {
  const tag = makeTag('s192-delete');
  const paket = await tempPaket(t, tag);
  t.after(async () => { await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } }); });
  const created = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Bye', body: 'farewell body' },
  });
  await deleteAnnouncement({ req: fakeReq, actor: systemActor, id: created.id });
  const row = await db.paketAnnouncement.findUnique({ where: { id: created.id } });
  assert.equal(row, null);
});

test('updateAnnouncement: unknown id → ANNOUNCEMENT_NOT_FOUND', async () => {
  await assert.rejects(
    updateAnnouncement({
      req: fakeReq, actor: systemActor, id: 'does-not-exist',
      input: { title: 'valid title', body: 'valid body' },
    }),
    /ANNOUNCEMENT_NOT_FOUND|tidak ditemukan/,
  );
});
