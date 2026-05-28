// Admin upsertDoc tests — the auto-stamping invariant.
//
// Stamps fire ONLY on status transition:
//   - submittedAt: only when going to SUBMITTED from a different status
//   - verifiedAt + verifiedById: only when going to VERIFIED from a different status
// Re-saving the same status MUST NOT bump the stamp (the doc panel re-submits
// the whole row on every edit; bumping stamps on no-op would mislead audit).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import { upsertDoc } from '../src/services/jemaahDocs.js';

const baseInput = (overrides = {}) => ({
  type: 'PASSPORT', status: 'PENDING', refNumber: '', expiresAt: '', notes: '',
  ...overrides,
});

describe('upsertDoc — auto-stamping', () => {
  test('PENDING → SUBMITTED stamps submittedAt; re-save same SUBMITTED preserves the stamp', async (t) => {
    const tag = makeTag('upsert-sub');
    const user = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: admin.id, email: admin.email, role: 'OWNER' };

    // Create as PENDING — no submittedAt
    const d1 = await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'PENDING', refNumber: 'A1' }),
    });
    assert.equal(d1.submittedAt, null);
    assert.equal(d1.verifiedAt, null);

    // PENDING → SUBMITTED — stamp fires
    const d2 = await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'SUBMITTED', refNumber: 'A1' }),
    });
    assert.ok(d2.submittedAt, 'submittedAt stamped on transition');
    const firstStamp = d2.submittedAt.getTime();

    // Re-save SUBMITTED with edited refNumber — stamp must NOT bump
    await new Promise((r) => setTimeout(r, 20)); // give clock room to advance
    const d3 = await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'SUBMITTED', refNumber: 'A1-edited' }),
    });
    assert.equal(d3.submittedAt.getTime(), firstStamp, 'no-op same-status save preserves submittedAt');
    assert.equal(d3.refNumber, 'A1-edited', 'refNumber DID update');
  });

  test('SUBMITTED → VERIFIED stamps verifiedAt + verifiedById; re-save VERIFIED preserves stamp', async (t) => {
    const tag = makeTag('upsert-ver');
    const user = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: admin.id, email: admin.email, role: 'OWNER' };

    // PENDING → VERIFIED in one step (skipping SUBMITTED): both submittedAt
    // and verifiedAt fire because each transitions from "not equal".
    await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'PENDING' }),
    });
    const d2 = await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'VERIFIED' }),
    });
    assert.ok(d2.verifiedAt);
    assert.equal(d2.verifiedById, admin.id);
    const firstVerifiedAt = d2.verifiedAt.getTime();

    // Re-save VERIFIED — verifiedAt NOT bumped, verifiedById preserved
    await new Promise((r) => setTimeout(r, 20));
    const otherAdmin = await tempUser(t, `${tag}-other`, { role: 'OWNER' });
    const d3 = await upsertDoc({
      req: fakeReq,
      actor: { id: otherAdmin.id, email: otherAdmin.email, role: 'OWNER' },
      jemaahId: user.jemaah.id,
      input: baseInput({ status: 'VERIFIED' }),
    });
    assert.equal(d3.verifiedAt.getTime(), firstVerifiedAt, 'verifiedAt preserved');
    assert.equal(d3.verifiedById, admin.id, 'original verifier preserved on re-save');
  });

  test('moving back from VERIFIED → REJECTED does NOT clear stamps (admin can audit history)', async (t) => {
    const tag = makeTag('upsert-back');
    const user = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: admin.id, email: admin.email, role: 'OWNER' };

    await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'VERIFIED' }),
    });
    // Verifier later changes mind and marks REJECTED
    const r = await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'REJECTED' }),
    });
    assert.equal(r.status, 'REJECTED');
    // Stamp history retained — admin can see this WAS verified at some point
    assert.ok(r.verifiedAt, 'verifiedAt retained for audit trail');
    assert.equal(r.verifiedById, admin.id);
  });

  test('audit row written on every upsert (CREATE first time, UPDATE thereafter)', async (t) => {
    const tag = makeTag('upsert-audit');
    const user = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const actor = { id: admin.id, email: admin.email, role: 'OWNER' };

    await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'PENDING' }),
    });
    const created = await db.auditLog.count({
      where: { actorEmail: admin.email, entity: 'JemaahDocument', action: 'CREATE' },
    });
    assert.equal(created, 1);

    await upsertDoc({
      req: fakeReq, actor, jemaahId: user.jemaah.id,
      input: baseInput({ status: 'SUBMITTED' }),
    });
    const updated = await db.auditLog.count({
      where: { actorEmail: admin.email, entity: 'JemaahDocument', action: 'UPDATE' },
    });
    assert.equal(updated, 1);

    t.after(() => db.auditLog.deleteMany({ where: { actorEmail: admin.email } }));
  });
});
