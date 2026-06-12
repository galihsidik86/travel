// Stage 240 — right-to-be-forgotten request flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import {
  submitDataDeletionRequest,
  decideDataDeletionRequest,
  listMyDataDeletionRequests,
  listPendingDataDeletionRequests,
} from '../src/services/dataDeletionRequest.js';

const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function cleanupRequest(t, userId) {
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'DataDeletionRequest' } });
    await db.dataDeletionRequest.deleteMany({ where: { userId } });
  });
}

test('submitDataDeletionRequest: 400 when reason < 10 chars', async (t) => {
  const tag = makeTag('s240-shortreason');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  await assert.rejects(
    () => submitDataDeletionRequest({
      req: fakeReq,
      actor: { id: u.id, email: u.email, role: 'JEMAAH' },
      userId: u.id,
      requestReason: 'too short',
    }),
    (err) => err.code === 'REQUEST_REASON_REQUIRED' && err.status === 400,
  );
});

test('submitDataDeletionRequest: creates PENDING row + audit', async (t) => {
  const tag = makeTag('s240-create');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const row = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'tidak akan booking lagi dengan operator ini',
  });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.userId, u.id);
  assert.match(row.requestReason, /tidak akan booking lagi/);

  const audits = await db.auditLog.findMany({
    where: { entity: 'DataDeletionRequest', entityId: row.id, action: 'CREATE' },
  });
  assert.equal(audits.length, 1);
});

test('submitDataDeletionRequest: refuses double-PENDING', async (t) => {
  const tag = makeTag('s240-double');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'satu permintaan pertama',
  });

  await assert.rejects(
    () => submitDataDeletionRequest({
      req: fakeReq,
      actor: { id: u.id, email: u.email, role: 'JEMAAH' },
      userId: u.id,
      requestReason: 'permintaan kedua bertumpuk',
    }),
    (err) => err.code === 'ALREADY_PENDING' && err.status === 409,
  );
});

test('decideDataDeletionRequest: flips PENDING → APPROVED with audit + notif', async (t) => {
  const tag = makeTag('s240-approve');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const row = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'tidak akan booking lagi dengan operator ini',
  });
  const updated = await decideDataDeletionRequest({
    req: fakeReq,
    actor: { id: null, email: 'owner@x', role: 'OWNER' },
    requestId: row.id,
    decision: 'APPROVED',
    decisionReason: 'sesuai permintaan jemaah',
  });
  assert.equal(updated.status, 'APPROVED');
  assert.equal(updated.decidedByEmail, 'owner@x');

  // Audit row
  const audits = await db.auditLog.findMany({
    where: { entity: 'DataDeletionRequest', entityId: row.id, action: 'UPDATE' },
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.status, 'APPROVED');

  // Jemaah notif enqueued
  const notif = await db.notification.findFirst({
    where: { relatedEntity: 'DataDeletionRequest', relatedEntityId: row.id, recipientUserId: u.id },
  });
  assert.ok(notif, 'jemaah notif enqueued');
  assert.match(notif.subject, /disetujui/);
});

test('decideDataDeletionRequest: DECLINED carries reason', async (t) => {
  const tag = makeTag('s240-decline');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const row = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'mau hapus semuanya sekarang',
  });
  const updated = await decideDataDeletionRequest({
    req: fakeReq,
    actor: { id: null, email: 'owner@x', role: 'OWNER' },
    requestId: row.id,
    decision: 'DECLINED',
    decisionReason: 'masih ada booking aktif — selesaikan dulu',
  });
  assert.equal(updated.status, 'DECLINED');
  assert.match(updated.decisionReason, /booking aktif/);
});

test('decideDataDeletionRequest: rejects unknown decision', async (t) => {
  const tag = makeTag('s240-baddec');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const row = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'reason cukup panjang ya',
  });
  await assert.rejects(
    () => decideDataDeletionRequest({
      req: fakeReq,
      actor: { id: null, email: 'owner@x', role: 'OWNER' },
      requestId: row.id,
      decision: 'MAYBE',
      decisionReason: 'ragu-ragu',
    }),
    (err) => err.code === 'BAD_DECISION' && err.status === 400,
  );
});

test('decideDataDeletionRequest: refuses on already-decided request', async (t) => {
  const tag = makeTag('s240-twice');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const row = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'reason untuk pertama kali',
  });
  await decideDataDeletionRequest({
    req: fakeReq,
    actor: { id: null, email: 'owner@x', role: 'OWNER' },
    requestId: row.id,
    decision: 'APPROVED',
    decisionReason: 'sudah diputus',
  });

  await assert.rejects(
    () => decideDataDeletionRequest({
      req: fakeReq,
      actor: { id: null, email: 'owner@x', role: 'OWNER' },
      requestId: row.id,
      decision: 'DECLINED',
      decisionReason: 'try again',
    }),
    (err) => err.code === 'ALREADY_DECIDED' && err.status === 409,
  );
});

test('listMyDataDeletionRequests: scoped to userId', async (t) => {
  const tag = makeTag('s240-scope');
  const me = await tempJemaah(t, tag + '-me');
  const other = await tempJemaah(t, tag + '-other');
  await cleanupRequest(t, me.id);
  await cleanupRequest(t, other.id);

  await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: me.id, email: me.email, role: 'JEMAAH' },
    userId: me.id,
    requestReason: 'permintaan saya pribadi',
  });
  await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: other.id, email: other.email, role: 'JEMAAH' },
    userId: other.id,
    requestReason: 'permintaan orang lain',
  });

  const myList = await listMyDataDeletionRequests({ userId: me.id });
  assert.equal(myList.length, 1);
  assert.equal(myList[0].userId, me.id);
});

test('listPendingDataDeletionRequests: includes user details', async (t) => {
  const tag = makeTag('s240-list');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'tolong hapus dong',
  });

  const pending = await listPendingDataDeletionRequests();
  const mine = pending.find((p) => p.userId === u.id);
  assert.ok(mine);
  assert.ok(mine.user);
  assert.equal(mine.user.email, u.email);
});

test('submitDataDeletionRequest: allows re-submit after prior DECLINED', async (t) => {
  const tag = makeTag('s240-resub');
  const u = await tempJemaah(t, tag);
  await cleanupRequest(t, u.id);

  const first = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'permintaan pertama saya',
  });
  await decideDataDeletionRequest({
    req: fakeReq,
    actor: { id: null, email: 'owner@x', role: 'OWNER' },
    requestId: first.id,
    decision: 'DECLINED',
    decisionReason: 'masih ada hutang',
  });
  // Now re-submit should work
  const second = await submitDataDeletionRequest({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'JEMAAH' },
    userId: u.id,
    requestReason: 'permintaan kedua, situasi berubah',
  });
  assert.equal(second.status, 'PENDING');
  assert.notEqual(second.id, first.id);
});
