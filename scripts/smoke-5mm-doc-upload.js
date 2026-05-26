// Smoke test for 5mm — JemaahDocument file upload.
//
// Exercises the service layer directly with a synthetic multer-shaped `file`
// object (write to OS temp, then call uploadMyDocFile). HTTP-layer multer
// behaviour (size limit, mime allowlist) is verified separately via end-to-end
// in dev — here we focus on:
//   1. Upload moves the file from temp → private/docs/<jemaahId>/<docId>__name.ext
//   2. Doc row gets filePath/Name/Size/mimeType/fileUploadedAt + status PENDING→SUBMITTED
//   3. Re-upload replaces the prior file on disk (no orphan)
//   4. getMyDocFileMeta returns the path for the owner; rejects (404) for someone else
//   5. getJemaahDocFileMeta enforces the (jemaahId, docId) tuple — wrong jemaahId → 404
//   6. deleteMyDocFile removes the file AND clears the row fields
//   7. Deleting the doc row (deleteMyDoc) also removes the file
//   8. sanitiseBasename strips path separators and weird chars
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  uploadMyDocFile, deleteMyDocFile, getMyDocFileMeta, getJemaahDocFileMeta,
} from '../src/services/jemaahDocFiles.js';
import { deleteMyDoc, submitMyDoc } from '../src/services/jemaahPortal.js';
import { sanitiseBasename, absFromRel, docsRoot } from '../src/lib/docStorage.js';

const tag = `smoke5mm-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function makeUserWithDoc(suffix, type) {
  const email = `${tag}-${suffix}@example.test`;
  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email, passwordHash, role: 'JEMAAH',
      fullName: `Smoke ${suffix}`, phone: '+628111111111',
      jemaah: { create: { fullName: `Smoke ${suffix}`, phone: '+628111111111', email } },
    },
    include: { jemaah: true },
  });
  // Create a doc via submitMyDoc so we get the canonical creation path
  const doc = await submitMyDoc({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: user.id, email: user.email, role: user.role },
    userId: user.id, input: { type, refNumber: '' },
  });
  return { user, doc };
}

async function makeTmpFile(content, suffix = '.pdf') {
  const p = path.join(os.tmpdir(), `smoke5mm-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  await fs.writeFile(p, content);
  return p;
}

async function main() {
  console.log(`\n[5mm smoke] tag=${tag}`);

  // 8. sanitiseBasename
  assert(sanitiseBasename('../../etc/passwd') === 'passwd', 'strips path traversal');
  assert(sanitiseBasename('My Paspor 2026!.PDF') === 'My_Paspor_2026', 'collapses spaces + drops ext');
  assert(sanitiseBasename('') === 'file', 'empty falls back to "file"');
  assert(sanitiseBasename('café-résumé') === 'cafe-resume', 'strips diacritics');

  const { user: userA, doc: docA } = await makeUserWithDoc('A', 'PASSPORT');
  const { user: userB, doc: docB } = await makeUserWithDoc('B', 'PASSPORT');
  console.log(`  userA=${userA.id} docA=${docA.id} userB=${userB.id} docB=${docB.id}`);

  // 1. Upload to A's doc
  const tmp1 = await makeTmpFile('PDF-MOCK-CONTENT-1');
  const upd1 = await uploadMyDocFile({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: userA.id, email: userA.email, role: userA.role },
    userId: userA.id, docId: docA.id,
    file: { path: tmp1, originalname: 'paspor.pdf', mimetype: 'application/pdf', size: 18 },
  });
  assert(upd1.filePath?.startsWith(`private/docs/${userA.jemaah.id}/${docA.id}__`), 'filePath layout correct');
  assert(upd1.fileName === 'paspor', 'fileName stored sanitised');
  assert(upd1.fileSize === 18 && upd1.mimeType === 'application/pdf', 'size + mime persisted');
  assert(upd1.status === 'SUBMITTED', 'PENDING doc → SUBMITTED on file upload');
  assert(await fileExists(absFromRel(upd1.filePath)), 'file persisted on disk');
  assert(!(await fileExists(tmp1)), 'tmp source moved (not copied)');

  // 3. Re-upload replaces
  const oldPath = absFromRel(upd1.filePath);
  const tmp2 = await makeTmpFile('PDF-MOCK-CONTENT-2-LONGER');
  const upd2 = await uploadMyDocFile({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: userA.id, email: userA.email, role: userA.role },
    userId: userA.id, docId: docA.id,
    file: { path: tmp2, originalname: 'paspor v2.pdf', mimetype: 'application/pdf', size: 25 },
  });
  assert(upd2.fileName === 'paspor_v2', 're-upload filename sanitised');
  assert(upd2.filePath !== upd1.filePath, 'filePath changed (basename differs)');
  assert(await fileExists(absFromRel(upd2.filePath)), 'new file written');
  assert(!(await fileExists(oldPath)), 'old file deleted (no orphan)');

  // 4. Jemaah download — owner gets it, stranger doesn't
  const metaOwn = await getMyDocFileMeta({ userId: userA.id, docId: docA.id });
  assert(metaOwn.absPath === absFromRel(upd2.filePath), 'owner resolves abs path');

  let stranger404 = false;
  try { await getMyDocFileMeta({ userId: userB.id, docId: docA.id }); }
  catch (e) { stranger404 = e.status === 404; }
  assert(stranger404, 'other user gets 404 on someone else\'s doc');

  // 5. Admin download tuple guard
  const adminMeta = await getJemaahDocFileMeta({ jemaahId: userA.jemaah.id, docId: docA.id });
  assert(adminMeta.fileName === 'paspor_v2', 'admin resolves doc by tuple');

  let tupleMiss = false;
  try { await getJemaahDocFileMeta({ jemaahId: userB.jemaah.id, docId: docA.id }); }
  catch (e) { tupleMiss = e.status === 404; }
  assert(tupleMiss, 'wrong jemaahId in URL → 404 (no cross-tenant probe)');

  // 6. deleteMyDocFile clears fields + removes file
  const pathBeforeDel = absFromRel(upd2.filePath);
  const afterDel = await deleteMyDocFile({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: userA.id, email: userA.email, role: userA.role },
    userId: userA.id, docId: docA.id,
  });
  assert(afterDel.filePath === null && afterDel.fileName === null, 'file fields cleared');
  assert(!(await fileExists(pathBeforeDel)), 'file gone from disk');

  // 7. Upload again, then delete the whole doc row → file should still be cleaned
  const tmp3 = await makeTmpFile('PDF-FOR-DELETE-TEST');
  const upd3 = await uploadMyDocFile({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: userA.id, email: userA.email, role: userA.role },
    userId: userA.id, docId: docA.id,
    file: { path: tmp3, originalname: 'final.pdf', mimetype: 'application/pdf', size: 19 },
  });
  const path3 = absFromRel(upd3.filePath);
  assert(await fileExists(path3), 'file present before doc delete');
  await deleteMyDoc({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: userA.id, email: userA.email, role: userA.role },
    userId: userA.id, docId: docA.id,
  });
  assert(!(await fileExists(path3)), 'doc-row delete also cleans up file');

  // Cleanup
  // Delete B's doc, then both users + audits
  await db.jemaahDocument.deleteMany({ where: { id: { in: [docB.id] } } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [userA.jemaah.id, userB.jemaah.id] } } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: [userA.email, userB.email] } } });
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  // Sweep per-jemaah dirs if empty
  for (const jid of [userA.jemaah.id, userB.jemaah.id]) {
    const dir = path.join(docsRoot, jid);
    try { await fs.rmdir(dir); } catch { /* not empty / not present */ }
  }
  console.log('  cleanup: users + profiles + docs + dirs');

  console.log('\n[5mm smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5mm smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
