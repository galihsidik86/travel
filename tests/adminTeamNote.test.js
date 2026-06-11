// Stage 179 — single-row shared note for admin team.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, fakeReq } from './_helpers.js';
import { getAdminTeamNote, updateAdminTeamNote, ADMIN_TEAM_NOTE_MAX_LEN } from '../src/services/adminTeamNote.js';

const SINGLETON = 'singleton';

// Cleanup before each test to keep ordering deterministic
async function reset() {
  await db.adminTeamNote.deleteMany({ where: { id: SINGLETON } });
  await db.auditLog.deleteMany({ where: { entity: 'AdminTeamNote' } });
}

test('getAdminTeamNote: returns null when no row exists', async (t) => {
  t.before(reset);
  const row = await getAdminTeamNote();
  assert.equal(row, null);
});

test('updateAdminTeamNote: first save creates row + audit', async (t) => {
  t.before(reset);
  const r = await updateAdminTeamNote({
    req: fakeReq,
    actor: { email: 'admin@example.test', role: 'OWNER' },
    body: 'Catatan pertama',
  });
  assert.equal(r.updated, true);
  assert.equal(r.row.body, 'Catatan pertama');
  assert.equal(r.row.updatedByEmail, 'admin@example.test');

  const audits = await db.auditLog.findMany({
    where: { entity: 'AdminTeamNote', action: 'UPDATE' },
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].before.body, null);
  assert.equal(audits[0].after.body, 'Catatan pertama');
});

test('updateAdminTeamNote: second save updates same row', async (t) => {
  t.before(reset);
  await updateAdminTeamNote({
    req: fakeReq, actor: { email: 'a@example.test' }, body: 'v1',
  });
  await updateAdminTeamNote({
    req: fakeReq, actor: { email: 'b@example.test' }, body: 'v2',
  });
  const row = await getAdminTeamNote();
  assert.equal(row.body, 'v2');
  assert.equal(row.updatedByEmail, 'b@example.test');
  // Only one row exists
  const all = await db.adminTeamNote.findMany({});
  assert.equal(all.length, 1);
});

test('updateAdminTeamNote: empty body clears note (null)', async (t) => {
  t.before(reset);
  await updateAdminTeamNote({ req: fakeReq, actor: { email: 'x' }, body: 'something' });
  const r = await updateAdminTeamNote({ req: fakeReq, actor: { email: 'x' }, body: '' });
  assert.equal(r.updated, true);
  assert.equal(r.row.body, null);
});

test('updateAdminTeamNote: no-op when value unchanged → no audit', async (t) => {
  t.before(reset);
  await updateAdminTeamNote({ req: fakeReq, actor: { email: 'x' }, body: 'same' });
  const auditsBefore = await db.auditLog.count({ where: { entity: 'AdminTeamNote' } });
  const r = await updateAdminTeamNote({ req: fakeReq, actor: { email: 'x' }, body: 'same' });
  assert.equal(r.updated, false);
  const auditsAfter = await db.auditLog.count({ where: { entity: 'AdminTeamNote' } });
  assert.equal(auditsAfter, auditsBefore, 'no audit on no-op');
});

test('updateAdminTeamNote: rejects too-long body', async (t) => {
  t.before(reset);
  const huge = 'x'.repeat(ADMIN_TEAM_NOTE_MAX_LEN + 1);
  await assert.rejects(
    updateAdminTeamNote({ req: fakeReq, actor: { email: 'x' }, body: huge }),
    /NOTE_TOO_LONG|karakter/,
  );
});

test('exported max length sane', () => {
  assert.equal(ADMIN_TEAM_NOTE_MAX_LEN, 4000);
});
