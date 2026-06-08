import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { listUsers, restoreUser } from '../src/services/userAdmin.js';
import { HttpError } from '../src/middleware/error.js';

test('listUsers: DELETED filter returns only soft-deleted rows', async (t) => {
  const tag = makeTag('lu-del');
  const live = await tempUser(t, `${tag}-l`, { role: 'OWNER' });
  const dead = await tempUser(t, `${tag}-d`, { role: 'OWNER', deletedAt: new Date() });

  const deletedOnly = await listUsers({ deleted: 'DELETED', search: tag });
  const ids = deletedOnly.map((u) => u.id);
  assert.ok(ids.includes(dead.id), 'soft-deleted should appear');
  assert.ok(!ids.includes(live.id), 'active should NOT appear');
});

test('listUsers: ACTIVE filter (default) excludes deleted', async (t) => {
  const tag = makeTag('lu-act');
  const live = await tempUser(t, `${tag}-l`, { role: 'OWNER' });
  const dead = await tempUser(t, `${tag}-d`, { role: 'OWNER', deletedAt: new Date() });

  const active = await listUsers({ search: tag });   // default
  const ids = active.map((u) => u.id);
  assert.ok(ids.includes(live.id));
  assert.ok(!ids.includes(dead.id));
});

test('listUsers: ALL filter returns both', async (t) => {
  const tag = makeTag('lu-all');
  const live = await tempUser(t, `${tag}-l`, { role: 'OWNER' });
  const dead = await tempUser(t, `${tag}-d`, { role: 'OWNER', deletedAt: new Date() });

  const all = await listUsers({ deleted: 'ALL', search: tag });
  const ids = all.map((u) => u.id);
  assert.ok(ids.includes(live.id));
  assert.ok(ids.includes(dead.id));
});

test('restoreUser: clears deletedAt + writes audit', async (t) => {
  const tag = makeTag('ru');
  const dead = await tempUser(t, tag, { role: 'OWNER', deletedAt: new Date() });
  const actor = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'User', entityId: dead.id } });
  });

  await restoreUser({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    userId: dead.id,
  });

  const after = await db.user.findUnique({ where: { id: dead.id }, select: { deletedAt: true } });
  assert.equal(after.deletedAt, null, 'deletedAt cleared');

  const audits = await db.auditLog.findMany({ where: { entity: 'User', entityId: dead.id, action: 'UPDATE' } });
  const restoredAudit = audits.find((a) => a.after?.restored === true);
  assert.ok(restoredAudit, 'restore audit row exists');
  assert.equal(restoredAudit.actorEmail, actor.email);
});

test('restoreUser: no-op on already-active row', async (t) => {
  const tag = makeTag('ru-noop');
  const live = await tempUser(t, tag, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  await restoreUser({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    userId: live.id,
  });

  // No audit row added for no-op restore
  const audits = await db.auditLog.findMany({ where: { entity: 'User', entityId: live.id, action: 'UPDATE' } });
  const restoredAudit = audits.find((a) => a.after?.restored === true);
  assert.equal(restoredAudit, undefined, 'no-op should not write audit');
});

test('restoreUser: 404 on unknown id', async () => {
  await assert.rejects(
    () => restoreUser({
      req: fakeReq,
      actor: { id: 'x', email: 'x', role: 'OWNER' },
      userId: 'nonexistent-id-xyz',
    }),
    (err) => err instanceof HttpError && err.code === 'USER_NOT_FOUND',
  );
});
