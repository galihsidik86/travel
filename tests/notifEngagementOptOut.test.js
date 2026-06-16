// Stage 309 — engagement opt-out toggle tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, fakeReq, systemActor } from './_helpers.js';
import { updateMyProfile } from '../src/services/jemaahPortal.js';

test('S309 — defaults to true on new profile', async (t) => {
  const tag = makeTag('s309a');
  const jem = await tempJemaah(t, tag);
  const fresh = await db.jemaahProfile.findUnique({
    where: { id: jem.jemaah.id },
    select: { notifEngagement: true },
  });
  assert.equal(fresh.notifEngagement, true);
});

test('S309 — opt-out (false) persists via updateMyProfile', async (t) => {
  const tag = makeTag('s309b');
  const jem = await tempJemaah(t, tag);
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await updateMyProfile({
    req: fakeReq, actor, userId: jem.id,
    input: {
      fullName: jem.jemaah.fullName, phone: '+628111234567',
      notifEngagement: false,
    },
  });
  const updated = await db.jemaahProfile.findUnique({
    where: { id: jem.jemaah.id },
    select: { notifEngagement: true },
  });
  assert.equal(updated.notifEngagement, false);
});

test('S309 — opt-back-in flips true again', async (t) => {
  const tag = makeTag('s309c');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: false },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await updateMyProfile({
    req: fakeReq, actor, userId: jem.id,
    input: {
      fullName: jem.jemaah.fullName, phone: '+628111234567',
      notifEngagement: true,
    },
  });
  const updated = await db.jemaahProfile.findUnique({
    where: { id: jem.jemaah.id },
    select: { notifEngagement: true },
  });
  assert.equal(updated.notifEngagement, true);
});

test('S309 — input field absent leaves notifEngagement untouched', async (t) => {
  const tag = makeTag('s309d');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id }, data: { notifEngagement: true },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  // Save profile without the field — should preserve.
  await updateMyProfile({
    req: fakeReq, actor, userId: jem.id,
    input: { fullName: jem.jemaah.fullName, phone: '+628111234567' },
  });
  const updated = await db.jemaahProfile.findUnique({
    where: { id: jem.jemaah.id },
    select: { notifEngagement: true },
  });
  assert.equal(updated.notifEngagement, true);
});

void systemActor; // unused but referenced by other tests in suite for shape consistency
