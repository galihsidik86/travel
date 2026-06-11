// Stage 204 — per-user audit activity timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { getUserActivityFeed, USER_ACTIVITY_DEFAULT_LIMIT } from '../src/services/userActivity.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempUser(t, tag) {
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'KASIR', fullName: `Kasir ${tag}`, phone: '+62811',
    },
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { actorUserId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('exported default limit sane', () => {
  assert.equal(USER_ACTIVITY_DEFAULT_LIMIT, 50);
});

test('getUserActivityFeed: empty userId → []', async () => {
  const r = await getUserActivityFeed({ userId: null });
  assert.deepEqual(r, []);
});

test('getUserActivityFeed: user with no audits → []', async (t) => {
  const tag = makeTag('s204-empty');
  const u = await tempUser(t, tag);
  const r = await getUserActivityFeed({ userId: u.id });
  assert.deepEqual(r, []);
});

test('getUserActivityFeed: returns recent entries for this user', async (t) => {
  const tag = makeTag('s204-pick');
  const u = await tempUser(t, tag);
  // Seed 3 audits
  for (let i = 0; i < 3; i++) {
    await db.auditLog.create({
      data: {
        actorUserId: u.id, actorEmail: u.email,
        action: 'CREATE', entity: 'TestEntity', entityId: `t-${i}`,
        createdAt: new Date(Date.now() - i * 1000),
      },
    });
  }
  const r = await getUserActivityFeed({ userId: u.id });
  assert.equal(r.length, 3);
  // Newest first
  assert.equal(r[0].entityId, 't-0');
  assert.equal(r[2].entityId, 't-2');
});

test('getUserActivityFeed: limits to requested count', async (t) => {
  const tag = makeTag('s204-limit');
  const u = await tempUser(t, tag);
  for (let i = 0; i < 25; i++) {
    await db.auditLog.create({
      data: {
        actorUserId: u.id, actorEmail: u.email,
        action: 'CREATE', entity: 'TestEntity', entityId: `t-${i}`,
        createdAt: new Date(Date.now() - i * 1000),
      },
    });
  }
  const r = await getUserActivityFeed({ userId: u.id, limit: 10 });
  assert.equal(r.length, 10);
});

test('getUserActivityFeed: limit clamps to safe range', async (t) => {
  const tag = makeTag('s204-clamp');
  const u = await tempUser(t, tag);
  // Negative limit → floors to 1
  const r1 = await getUserActivityFeed({ userId: u.id, limit: -5 });
  assert.equal(r1.length, 0, 'empty regardless when no audits'); // confirms no crash
  // Too-large limit → capped at 200
  for (let i = 0; i < 250; i++) {
    await db.auditLog.create({
      data: {
        actorUserId: u.id, actorEmail: u.email,
        action: 'CREATE', entity: 'TestEntity', entityId: `t-${i}`,
      },
    });
  }
  const r2 = await getUserActivityFeed({ userId: u.id, limit: 999 });
  assert.equal(r2.length, 200, 'capped at 200');
});

test('getUserActivityFeed: only returns audits where target is the actor', async (t) => {
  const tag = makeTag('s204-actor');
  const u = await tempUser(t, tag);
  // Audit by this user
  await db.auditLog.create({
    data: {
      actorUserId: u.id, actorEmail: u.email,
      action: 'CREATE', entity: 'TestEntity', entityId: 'mine',
    },
  });
  // Audit by someone else (anonymous)
  const otherAudit = await db.auditLog.create({
    data: {
      actorUserId: null, actorEmail: 'other@example.test',
      action: 'CREATE', entity: 'TestEntity', entityId: 'theirs',
    },
  });
  t.after(async () => { await db.auditLog.deleteMany({ where: { id: otherAudit.id } }); });

  const r = await getUserActivityFeed({ userId: u.id });
  const entityIds = r.map((a) => a.entityId);
  assert.ok(entityIds.includes('mine'));
  assert.ok(!entityIds.includes('theirs'));
});
