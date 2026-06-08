import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, fakeReq } from './_helpers.js';
import { updateJemaah } from '../src/services/jemaahAdmin.js';

test('updateJemaah: opt-out stamps notifWaWithdrawnAt, leaves consentAt alone', async (t) => {
  const tag = makeTag('wa-out');
  const j = await tempJemaah(t, tag);
  // Backfill a consentAt so we can verify it survives the withdrawal
  const consentAt = new Date('2026-01-15T08:30:00Z');
  await db.jemaahProfile.update({
    where: { id: j.jemaah.id },
    data: { notifWa: true, notifWaConsentAt: consentAt, notifWaWithdrawnAt: null },
  });

  await updateJemaah({
    req: fakeReq,
    actor: { id: j.id, email: j.email, role: 'OWNER' },
    jemaahId: j.jemaah.id,
    input: {
      fullName: j.jemaah.fullName, phone: j.jemaah.phone,
      notifWa: false,
    },
  });

  const after = await db.jemaahProfile.findUnique({ where: { id: j.jemaah.id } });
  assert.equal(after.notifWa, false);
  assert.ok(after.notifWaWithdrawnAt instanceof Date, 'withdrawnAt should be stamped');
  // consentAt should be unchanged (durable history)
  assert.equal(after.notifWaConsentAt.toISOString(), consentAt.toISOString());
});

test('updateJemaah: re-opt-in stamps fresh consentAt + keeps last withdrawal', async (t) => {
  const tag = makeTag('wa-in');
  const j = await tempJemaah(t, tag);
  const withdrawnAt = new Date('2026-02-10T12:00:00Z');
  await db.jemaahProfile.update({
    where: { id: j.jemaah.id },
    data: { notifWa: false, notifWaConsentAt: new Date('2026-01-01T00:00:00Z'), notifWaWithdrawnAt: withdrawnAt },
  });

  await updateJemaah({
    req: fakeReq,
    actor: { id: j.id, email: j.email, role: 'OWNER' },
    jemaahId: j.jemaah.id,
    input: {
      fullName: j.jemaah.fullName, phone: j.jemaah.phone,
      notifWa: true,
    },
  });

  const after = await db.jemaahProfile.findUnique({ where: { id: j.jemaah.id } });
  assert.equal(after.notifWa, true);
  // consentAt should be fresh — newer than the original
  assert.ok(after.notifWaConsentAt.getTime() > new Date('2026-01-01T00:00:00Z').getTime());
  // withdrawnAt should NOT be cleared (audit-friendly: the last withdrawal is history)
  assert.equal(after.notifWaWithdrawnAt.toISOString(), withdrawnAt.toISOString());
});

test('updateJemaah: notifWa unchanged → no consent stamp written', async (t) => {
  const tag = makeTag('wa-noop');
  const j = await tempJemaah(t, tag);
  const consentAt = new Date('2026-03-01T08:00:00Z');
  await db.jemaahProfile.update({
    where: { id: j.jemaah.id },
    data: { notifWa: true, notifWaConsentAt: consentAt, notifWaWithdrawnAt: null },
  });

  await updateJemaah({
    req: fakeReq,
    actor: { id: j.id, email: j.email, role: 'OWNER' },
    jemaahId: j.jemaah.id,
    input: {
      fullName: j.jemaah.fullName, phone: j.jemaah.phone,
      notifWa: true,  // same as before
    },
  });

  const after = await db.jemaahProfile.findUnique({ where: { id: j.jemaah.id } });
  assert.equal(after.notifWaConsentAt.toISOString(), consentAt.toISOString(),
    'no-op should NOT bump consentAt');
});

test('updateJemaah: notifWa omitted from input → no consent stamp change', async (t) => {
  const tag = makeTag('wa-omit');
  const j = await tempJemaah(t, tag);
  const consentAt = new Date('2026-04-01T08:00:00Z');
  await db.jemaahProfile.update({
    where: { id: j.jemaah.id },
    data: { notifWa: true, notifWaConsentAt: consentAt, notifWaWithdrawnAt: null },
  });

  await updateJemaah({
    req: fakeReq,
    actor: { id: j.id, email: j.email, role: 'OWNER' },
    jemaahId: j.jemaah.id,
    input: {
      fullName: 'Updated Name',
      phone: j.jemaah.phone,
      // notifWa NOT sent
    },
  });

  const after = await db.jemaahProfile.findUnique({ where: { id: j.jemaah.id } });
  assert.equal(after.fullName, 'Updated Name', 'name updated');
  assert.equal(after.notifWa, true, 'notifWa unchanged');
  assert.equal(after.notifWaConsentAt.toISOString(), consentAt.toISOString(), 'consentAt unchanged');
});
