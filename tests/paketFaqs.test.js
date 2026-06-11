// Stage 190 — per-paket FAQ CRUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import {
  listFaqs, createFaq, updateFaq, deleteFaq,
} from '../src/services/paketFaqs.js';

test('listFaqs: empty paket returns []', async (t) => {
  const tag = makeTag('s190-empty');
  const paket = await tempPaket(t, tag);
  const rows = await listFaqs(paket.id);
  assert.equal(rows.length, 0);
});

test('createFaq: writes row + audit', async (t) => {
  const tag = makeTag('s190-create');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketFaq' } });
    await db.paketFaq.deleteMany({ where: { paketId: paket.id } });
  });
  const r = await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'Apakah harga sudah include?', answer: 'Ya, kecuali oleh-oleh.', sortOrder: 1 },
  });
  assert.equal(r.question, 'Apakah harga sudah include?');
  assert.equal(r.sortOrder, 1);

  const audits = await db.auditLog.findMany({
    where: { entity: 'PaketFaq', action: 'CREATE' },
  });
  assert.ok(audits.length >= 1);
});

test('createFaq: rejects too-short fields', async (t) => {
  const tag = makeTag('s190-validate');
  const paket = await tempPaket(t, tag);
  await assert.rejects(
    createFaq({
      req: fakeReq, actor: systemActor, paketId: paket.id,
      input: { question: 'A', answer: 'B' },
    }),
    /minimal 3/,
  );
});

test('createFaq: unknown paketId → PAKET_NOT_FOUND', async () => {
  await assert.rejects(
    createFaq({
      req: fakeReq, actor: systemActor, paketId: 'does-not-exist',
      input: { question: 'valid q?', answer: 'valid a' },
    }),
    /PAKET_NOT_FOUND|tidak ditemukan/,
  );
});

test('listFaqs: sorted by sortOrder asc, createdAt asc', async (t) => {
  const tag = makeTag('s190-sort');
  const paket = await tempPaket(t, tag);
  t.after(async () => { await db.paketFaq.deleteMany({ where: { paketId: paket.id } }); });
  await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'Z question A?', answer: 'answer 1', sortOrder: 9 },
  });
  await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'A question B?', answer: 'answer 2', sortOrder: 1 },
  });
  await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'M question C?', answer: 'answer 3', sortOrder: 1 },
  });
  const rows = await listFaqs(paket.id);
  assert.equal(rows.length, 3);
  // sortOrder=1 rows first, then sortOrder=9. Within same sort, createdAt asc.
  assert.equal(rows[0].sortOrder, 1);
  assert.equal(rows[1].sortOrder, 1);
  assert.equal(rows[2].sortOrder, 9);
});

test('updateFaq: changes question + body + audit before/after', async (t) => {
  const tag = makeTag('s190-update');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketFaq' } });
    await db.paketFaq.deleteMany({ where: { paketId: paket.id } });
  });
  const created = await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'pertanyaan satu?', answer: 'jawaban awal' },
  });
  await updateFaq({
    req: fakeReq, actor: systemActor, id: created.id,
    input: { question: 'pertanyaan dua?', answer: 'jawaban baru', sortOrder: 5 },
  });
  const row = await db.paketFaq.findUnique({ where: { id: created.id } });
  assert.equal(row.question, 'pertanyaan dua?');
  assert.equal(row.sortOrder, 5);

  const upd = await db.auditLog.findFirst({
    where: { entity: 'PaketFaq', action: 'UPDATE', entityId: created.id },
  });
  assert.equal(upd.before.question, 'pertanyaan satu?');
  assert.equal(upd.after.question, 'pertanyaan dua?');
});

test('updateFaq: unknown id → FAQ_NOT_FOUND', async () => {
  await assert.rejects(
    updateFaq({
      req: fakeReq, actor: systemActor, id: 'does-not-exist',
      input: { question: 'pertanyaan?', answer: 'jawaban' },
    }),
    /FAQ_NOT_FOUND|tidak ditemukan/,
  );
});

test('deleteFaq: removes row + writes DELETE audit', async (t) => {
  const tag = makeTag('s190-delete');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketFaq' } });
    await db.paketFaq.deleteMany({ where: { paketId: paket.id } });
  });
  const created = await createFaq({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { question: 'pertanyaan?', answer: 'jawaban' },
  });
  await deleteFaq({ req: fakeReq, actor: systemActor, id: created.id });
  const row = await db.paketFaq.findUnique({ where: { id: created.id } });
  assert.equal(row, null);
  const del = await db.auditLog.findFirst({
    where: { entity: 'PaketFaq', action: 'DELETE', entityId: created.id },
  });
  assert.equal(del.before.question, 'pertanyaan?');
});
