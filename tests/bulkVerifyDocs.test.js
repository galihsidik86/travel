// Stage 248 — bulk doc verify on jemaah edit page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import { bulkVerifyDocs } from '../src/services/jemaahDocs.js';

const sysActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function makeDoc(jemaahId, type, status) {
  return db.jemaahDocument.create({
    data: { jemaahId, type, status },
  });
}

test('bulkVerifyDocs: empty docIds → zero counters', async (t) => {
  const tag = makeTag('s248-empty');
  const u = await tempJemaah(t, tag);
  const r = await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id, docIds: [] });
  assert.deepEqual(r, { requested: 0, verified: 0, skipped: 0, failed: 0 });
});

test('bulkVerifyDocs: flips SUBMITTED → VERIFIED with stamps', async (t) => {
  const tag = makeTag('s248-flip');
  const u = await tempJemaah(t, tag);
  const d = await makeDoc(u.jemaah.id, 'PASSPORT', 'SUBMITTED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id, docIds: [d.id] });
  assert.equal(r.verified, 1);
  const fresh = await db.jemaahDocument.findUnique({ where: { id: d.id } });
  assert.equal(fresh.status, 'VERIFIED');
  assert.ok(fresh.verifiedAt);
});

test('bulkVerifyDocs: skips already-VERIFIED docs (idempotent)', async (t) => {
  const tag = makeTag('s248-already');
  const u = await tempJemaah(t, tag);
  const d = await makeDoc(u.jemaah.id, 'PASSPORT', 'VERIFIED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id, docIds: [d.id] });
  assert.equal(r.verified, 0);
  assert.ok(r.skippedReasons.some((s) => s.reason === 'already_verified'));
});

test('bulkVerifyDocs: refuses REJECTED docs (admin should re-handle individually)', async (t) => {
  const tag = makeTag('s248-rejected');
  const u = await tempJemaah(t, tag);
  const d = await makeDoc(u.jemaah.id, 'PASSPORT', 'REJECTED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id, docIds: [d.id] });
  assert.equal(r.verified, 0);
  assert.ok(r.skippedReasons.some((s) => s.reason === 'rejected'));
});

test('bulkVerifyDocs: tuple guard — silently skips cross-jemaah doc IDs', async (t) => {
  const tag = makeTag('s248-tuple');
  const u1 = await tempJemaah(t, tag + '-1');
  const u2 = await tempJemaah(t, tag + '-2');
  // d belongs to u2 but we call bulkVerify with jemaahId=u1
  const d = await makeDoc(u2.jemaah.id, 'PASSPORT', 'SUBMITTED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u2.jemaah.id } }); });

  const r = await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u1.jemaah.id, docIds: [d.id] });
  assert.equal(r.verified, 0);
  // d.status should remain SUBMITTED — not touched
  const fresh = await db.jemaahDocument.findUnique({ where: { id: d.id } });
  assert.equal(fresh.status, 'SUBMITTED');
});

test('bulkVerifyDocs: writes audit row per successful verify', async (t) => {
  const tag = makeTag('s248-audit');
  const u = await tempJemaah(t, tag);
  const d = await makeDoc(u.jemaah.id, 'PASSPORT', 'SUBMITTED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  await bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id, docIds: [d.id] });

  const audits = await db.auditLog.findMany({
    where: { entity: 'JemaahDocument', entityId: d.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' }, take: 1,
  });
  assert.equal(audits[0].after.status, 'VERIFIED');
  assert.equal(audits[0].after.bulkVerified, true);
});

test('bulkVerifyDocs: mixed batch — verifies eligible, skips others, no abort', async (t) => {
  const tag = makeTag('s248-mixed');
  const u = await tempJemaah(t, tag);
  const submitted = await makeDoc(u.jemaah.id, 'PASSPORT', 'SUBMITTED');
  const verified = await makeDoc(u.jemaah.id, 'VISA_UMROH', 'VERIFIED');
  const rejected = await makeDoc(u.jemaah.id, 'MANASIK_CERT', 'REJECTED');
  t.after(async () => { await db.jemaahDocument.deleteMany({ where: { jemaahId: u.jemaah.id } }); });

  const r = await bulkVerifyDocs({
    req: fakeReq, actor: sysActor, jemaahId: u.jemaah.id,
    docIds: [submitted.id, verified.id, rejected.id],
  });
  assert.equal(r.requested, 3);
  assert.equal(r.verified, 1);
  // verified + rejected both skip
  assert.ok(r.skippedReasons.length >= 2);

  // Only the SUBMITTED → VERIFIED was flipped
  const a = await db.jemaahDocument.findUnique({ where: { id: submitted.id } });
  const b = await db.jemaahDocument.findUnique({ where: { id: verified.id } });
  const c = await db.jemaahDocument.findUnique({ where: { id: rejected.id } });
  assert.equal(a.status, 'VERIFIED');
  assert.equal(b.status, 'VERIFIED');
  assert.equal(c.status, 'REJECTED');
});

test('bulkVerifyDocs: 404 on unknown jemaah', async () => {
  await assert.rejects(
    () => bulkVerifyDocs({ req: fakeReq, actor: sysActor, jemaahId: 'no-such', docIds: ['x'] }),
    (err) => err.status === 404,
  );
});
