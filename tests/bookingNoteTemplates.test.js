// Stage 180 — reusable note templates for booking notes textarea.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, fakeReq, systemActor } from './_helpers.js';
import {
  listNoteTemplates, createNoteTemplate, updateNoteTemplate, deleteNoteTemplate,
} from '../src/services/bookingNoteTemplates.js';

async function cleanup(t) {
  t.after(async () => {
    await db.bookingNoteTemplate.deleteMany({});
    await db.auditLog.deleteMany({ where: { entity: 'BookingNoteTemplate' } });
  });
}

test('createNoteTemplate: writes row + audit', async (t) => {
  await cleanup(t);
  const tag = makeTag('s180-c');
  const row = await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-lansia`, body: 'Lansia perlu kursi roda', sortOrder: 5 },
  });
  assert.equal(row.name, `${tag}-lansia`);
  assert.equal(row.body, 'Lansia perlu kursi roda');
  assert.equal(row.sortOrder, 5);

  const audits = await db.auditLog.findMany({
    where: { entity: 'BookingNoteTemplate', action: 'CREATE' },
  });
  assert.ok(audits.length >= 1);
});

test('createNoteTemplate: duplicate name → TEMPLATE_NAME_TAKEN', async (t) => {
  await cleanup(t);
  const tag = makeTag('s180-dup');
  await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-x`, body: 'first' },
  });
  await assert.rejects(
    createNoteTemplate({
      req: fakeReq, actor: systemActor,
      input: { name: `${tag}-x`, body: 'second' },
    }),
    /TEMPLATE_NAME_TAKEN|sudah ada/,
  );
});

test('createNoteTemplate: rejects too-short name', async (t) => {
  await cleanup(t);
  await assert.rejects(
    createNoteTemplate({
      req: fakeReq, actor: systemActor,
      input: { name: 'a', body: 'too short name' },
    }),
    /minimal 2/,
  );
});

test('listNoteTemplates: sorted by sortOrder then name', async (t) => {
  await cleanup(t);
  const tag = makeTag('s180-sort');
  await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-z-high`, body: 'high sort, z name', sortOrder: 99 },
  });
  await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-a-low`, body: 'low sort, a name', sortOrder: 1 },
  });
  await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-b-low`, body: 'low sort, b name', sortOrder: 1 },
  });
  const rows = await listNoteTemplates();
  const mine = rows.filter((r) => r.name.startsWith(tag));
  assert.equal(mine[0].name, `${tag}-a-low`, 'lowest sortOrder + alphabetical first');
  assert.equal(mine[1].name, `${tag}-b-low`);
  assert.equal(mine[2].name, `${tag}-z-high`);
});

test('updateNoteTemplate: edits + audit before/after', async (t) => {
  await cleanup(t);
  const tag = makeTag('s180-u');
  const created = await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-name`, body: 'old body' },
  });
  await updateNoteTemplate({
    req: fakeReq, actor: systemActor, id: created.id,
    input: { name: `${tag}-name`, body: 'new body', sortOrder: 10 },
  });
  const row = await db.bookingNoteTemplate.findUnique({ where: { id: created.id } });
  assert.equal(row.body, 'new body');
  assert.equal(row.sortOrder, 10);

  const upd = await db.auditLog.findFirst({
    where: { entity: 'BookingNoteTemplate', action: 'UPDATE', entityId: created.id },
  });
  assert.equal(upd.before.body, 'old body');
  assert.equal(upd.after.body, 'new body');
});

test('updateNoteTemplate: unknown id → TEMPLATE_NOT_FOUND', async (t) => {
  await cleanup(t);
  await assert.rejects(
    updateNoteTemplate({
      req: fakeReq, actor: systemActor, id: 'does-not-exist',
      input: { name: 'x', body: 'y' },
    }),
    /TEMPLATE_NOT_FOUND|tidak ditemukan/,
  );
});

test('deleteNoteTemplate: removes row + writes DELETE audit', async (t) => {
  await cleanup(t);
  const tag = makeTag('s180-d');
  const created = await createNoteTemplate({
    req: fakeReq, actor: systemActor,
    input: { name: `${tag}-del`, body: 'will be deleted' },
  });
  await deleteNoteTemplate({
    req: fakeReq, actor: systemActor, id: created.id,
  });
  const row = await db.bookingNoteTemplate.findUnique({ where: { id: created.id } });
  assert.equal(row, null);
  const del = await db.auditLog.findFirst({
    where: { entity: 'BookingNoteTemplate', action: 'DELETE', entityId: created.id },
  });
  assert.equal(del.before.name, `${tag}-del`);
});
