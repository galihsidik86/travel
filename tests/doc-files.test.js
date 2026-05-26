// JemaahDocument file upload tests (5mm). Touches filesystem + DB.
// Uses OS temp for source files; cleanup wipes private/docs/<jemaahId>/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { db, makeTag, tempJemaah, fakeReq, systemActor } from './_helpers.js';
import {
  uploadMyDocFile, deleteMyDocFile, getMyDocFileMeta, getJemaahDocFileMeta,
} from '../src/services/jemaahDocFiles.js';
import { deleteMyDoc, submitMyDoc } from '../src/services/jemaahPortal.js';
import { absFromRel, docsRoot } from '../src/lib/docStorage.js';

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function tmpFile(content, suffix = '.pdf') {
  const p = path.join(os.tmpdir(), `t-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  await fs.writeFile(p, content);
  return p;
}

async function makeDoc(user, type = 'PASSPORT') {
  return submitMyDoc({
    req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
    userId: user.id, input: { type, refNumber: '' },
  });
}

describe('uploadMyDocFile', () => {
  test('moves file to per-jemaah dir + sets row fields + transitions PENDING→SUBMITTED', async (t) => {
    const tag = makeTag('5mm-up');
    const user = await tempJemaah(t, tag);
    const doc = await makeDoc(user);
    t.after(async () => {
      const dir = path.join(docsRoot, user.jemaah.id);
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    const src = await tmpFile('PDF-MOCK-CONTENT');
    const updated = await uploadMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
      file: { path: src, originalname: 'paspor.pdf', mimetype: 'application/pdf', size: 16 },
    });
    assert.ok(updated.filePath.startsWith(`private/docs/${user.jemaah.id}/${doc.id}__`));
    assert.equal(updated.fileName, 'paspor');
    assert.equal(updated.mimeType, 'application/pdf');
    assert.equal(updated.status, 'SUBMITTED', 'PENDING → SUBMITTED on first upload');
    assert.ok(await fileExists(absFromRel(updated.filePath)), 'file landed on disk');
    assert.ok(!(await fileExists(src)), 'source moved (not copied)');
  });

  test('re-upload replaces previous file (no orphan)', async (t) => {
    const tag = makeTag('5mm-replace');
    const user = await tempJemaah(t, tag);
    const doc = await makeDoc(user);
    t.after(async () => {
      const dir = path.join(docsRoot, user.jemaah.id);
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    const a = await uploadMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
      file: { path: await tmpFile('v1'), originalname: 'paspor.pdf', mimetype: 'application/pdf', size: 2 },
    });
    const oldPath = absFromRel(a.filePath);

    const b = await uploadMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
      file: { path: await tmpFile('v2-longer'), originalname: 'paspor v2.pdf', mimetype: 'application/pdf', size: 10 },
    });
    assert.equal(b.fileName, 'paspor_v2', 'sanitised filename');
    assert.notEqual(b.filePath, a.filePath, 'filePath changed');
    assert.ok(await fileExists(absFromRel(b.filePath)), 'new file written');
    assert.ok(!(await fileExists(oldPath)), 'old file removed');
  });

  test('rejects disallowed mime', async (t) => {
    const tag = makeTag('5mm-mime');
    const user = await tempJemaah(t, tag);
    const doc = await makeDoc(user);

    await assert.rejects(
      uploadMyDocFile({
        req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
        userId: user.id, docId: doc.id,
        file: { path: await tmpFile('x'), originalname: 'evil.exe', mimetype: 'application/x-msdownload', size: 1 },
      }),
      (err) => err.code === 'INVALID_FILE_TYPE',
    );
  });
});

describe('download access control', () => {
  test('owner resolves; stranger 404; admin tuple-guard rejects cross-jemaah', async (t) => {
    const tag = makeTag('5mm-acl');
    const owner = await tempJemaah(t, `${tag}-o`);
    const stranger = await tempJemaah(t, `${tag}-s`);
    const doc = await makeDoc(owner);
    t.after(async () => {
      const dir = path.join(docsRoot, owner.jemaah.id);
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    await uploadMyDocFile({
      req: fakeReq, actor: { id: owner.id, email: owner.email, role: owner.role },
      userId: owner.id, docId: doc.id,
      file: { path: await tmpFile('content'), originalname: 'paspor.pdf', mimetype: 'application/pdf', size: 7 },
    });

    // Owner self-download OK
    const m = await getMyDocFileMeta({ userId: owner.id, docId: doc.id });
    assert.ok(m.absPath);
    assert.equal(m.fileName, 'paspor');

    // Stranger gets 404
    await assert.rejects(
      getMyDocFileMeta({ userId: stranger.id, docId: doc.id }),
      (err) => err.code === 'DOC_NOT_FOUND',
    );

    // Admin owner-side: correct tuple OK
    const adminOk = await getJemaahDocFileMeta({ jemaahId: owner.jemaah.id, docId: doc.id });
    assert.equal(adminOk.fileName, 'paspor');

    // Admin wrong tuple: 404 (anti-enumeration)
    await assert.rejects(
      getJemaahDocFileMeta({ jemaahId: stranger.jemaah.id, docId: doc.id }),
      (err) => err.code === 'DOC_NOT_FOUND',
    );
  });
});

describe('delete cleans up file', () => {
  test('deleteMyDocFile clears row fields + removes blob', async (t) => {
    const tag = makeTag('5mm-delfile');
    const user = await tempJemaah(t, tag);
    const doc = await makeDoc(user);
    t.after(async () => {
      const dir = path.join(docsRoot, user.jemaah.id);
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* */ }
    });
    const u = await uploadMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
      file: { path: await tmpFile('to-del'), originalname: 'x.pdf', mimetype: 'application/pdf', size: 6 },
    });
    const filePath = absFromRel(u.filePath);

    const cleared = await deleteMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
    });
    assert.equal(cleared.filePath, null);
    assert.equal(cleared.fileName, null);
    assert.ok(!(await fileExists(filePath)), 'file gone from disk');
  });

  test('deleteMyDoc (whole row) also wipes attached file', async (t) => {
    const tag = makeTag('5mm-delrow');
    const user = await tempJemaah(t, tag);
    const doc = await makeDoc(user);
    t.after(async () => {
      const dir = path.join(docsRoot, user.jemaah.id);
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* */ }
    });
    const u = await uploadMyDocFile({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
      file: { path: await tmpFile('whole-row'), originalname: 'x.pdf', mimetype: 'application/pdf', size: 9 },
    });
    const filePath = absFromRel(u.filePath);

    await deleteMyDoc({
      req: fakeReq, actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, docId: doc.id,
    });
    assert.ok(!(await fileExists(filePath)), 'file cleaned with row');
  });
});
