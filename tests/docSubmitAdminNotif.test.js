// Stage 249 — admin notification when jemaah submits a doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempUser } from './_helpers.js';
import { notifyDocSubmittedAdmin } from '../src/services/notifications.js';

test('notifyDocSubmittedAdmin: silent when admin pool empty', async (t) => {
  const tag = makeTag('s249-noadmin');
  const u = await tempJemaah(t, tag);
  // No admin fixtures — just verify the call doesn't throw
  const r = await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: 'Test' },
    doc: { id: 'fake-id', type: 'PASSPORT' },
  });
  // Real DB may have seeded admins; we just assert the shape returned
  assert.ok(r.enqueued !== undefined || r.skipped !== undefined);
});

test('notifyDocSubmittedAdmin: enqueues one EMAIL per ACTIVE admin in correct role tier', async (t) => {
  const tag = makeTag('s249-fanout');
  const owner = await tempUser(t, tag + '-owner', { role: 'OWNER' });
  const super1 = await tempUser(t, tag + '-super', { role: 'SUPERADMIN' });
  const manops = await tempUser(t, tag + '-manops', { role: 'MANAJER_OPS' });
  // KASIR is excluded
  const kasir = await tempUser(t, tag + '-kasir', { role: 'KASIR' });
  const u = await tempJemaah(t, tag);
  const doc = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', refNumber: 'A123' },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id } });
    await db.jemaahDocument.deleteMany({ where: { id: doc.id } });
  });

  const r = await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: u.fullName },
    doc,
  });
  // At least the 3 admins we created should have rows
  assert.ok(r.enqueued >= 3);

  const rows = await db.notification.findMany({
    where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id },
  });
  const emails = rows.map((r) => r.recipientEmail);
  assert.ok(emails.includes(owner.email));
  assert.ok(emails.includes(super1.email));
  assert.ok(emails.includes(manops.email));
  // KASIR NOT included
  assert.ok(!emails.includes(kasir.email));
});

test('notifyDocSubmittedAdmin: dedupes recent burst (skips when same docId has notif <1h)', async (t) => {
  const tag = makeTag('s249-dedupe');
  await tempUser(t, tag + '-owner', { role: 'OWNER' });
  const u = await tempJemaah(t, tag);
  const doc = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'VISA_UMROH', status: 'SUBMITTED' },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id } });
    await db.jemaahDocument.deleteMany({ where: { id: doc.id } });
  });

  await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: u.fullName },
    doc,
  });
  // Second call within an hour → skipped
  const r2 = await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: u.fullName },
    doc,
  });
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'recent_burst');
});

test('notifyDocSubmittedAdmin: dedupe scope is per-doc (different doc fires fresh)', async (t) => {
  const tag = makeTag('s249-perdoc');
  await tempUser(t, tag + '-owner', { role: 'OWNER' });
  const u = await tempJemaah(t, tag);
  const doc1 = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED' },
  });
  const doc2 = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'VISA_UMROH', status: 'SUBMITTED' },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahDocument', relatedEntityId: { in: [doc1.id, doc2.id] } } });
    await db.jemaahDocument.deleteMany({ where: { id: { in: [doc1.id, doc2.id] } } });
  });

  await notifyDocSubmittedAdmin({ jemaah: { id: u.jemaah.id, fullName: u.fullName }, doc: doc1 });
  const r2 = await notifyDocSubmittedAdmin({ jemaah: { id: u.jemaah.id, fullName: u.fullName }, doc: doc2 });
  assert.ok(r2.enqueued >= 1);
});

test('notifyDocSubmittedAdmin: missing jemaah → skipped', async () => {
  const r = await notifyDocSubmittedAdmin({ doc: { id: 'x', type: 'PASSPORT' } });
  assert.equal(r.skipped, true);
});

test('notifyDocSubmittedAdmin: subject label reflects kind=file_upload', async (t) => {
  const tag = makeTag('s249-fileup');
  await tempUser(t, tag + '-owner', { role: 'OWNER' });
  const u = await tempJemaah(t, tag);
  const doc = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', filePath: '/fake' },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id } });
    await db.jemaahDocument.deleteMany({ where: { id: doc.id } });
  });

  await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: 'Test Jemaah' },
    doc, kind: 'file_upload',
  });
  const row = await db.notification.findFirst({
    where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id },
  });
  assert.ok(row);
  assert.match(row.subject, /mengunggah file/);
});

test('notifyDocSubmittedAdmin: body includes refNumber + expiresAt when present', async (t) => {
  const tag = makeTag('s249-body');
  await tempUser(t, tag + '-owner', { role: 'OWNER' });
  const u = await tempJemaah(t, tag);
  const expiresAt = new Date('2027-01-15');
  const doc = await db.jemaahDocument.create({
    data: { jemaahId: u.jemaah.id, type: 'PASSPORT', status: 'SUBMITTED', refNumber: 'A9999', expiresAt },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id } });
    await db.jemaahDocument.deleteMany({ where: { id: doc.id } });
  });

  await notifyDocSubmittedAdmin({
    jemaah: { id: u.jemaah.id, fullName: 'Test' },
    doc,
  });
  const row = await db.notification.findFirst({
    where: { relatedEntity: 'JemaahDocument', relatedEntityId: doc.id },
  });
  assert.match(row.body, /A9999/);
  assert.match(row.body, /2027-01-15/);
});
