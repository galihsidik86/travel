// Stage 181 — paginated notification inbox helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { listMyNotificationsPaginated } from '../src/services/jemaahPortal.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempUserWithNotifs(t, tag, count = 0) {
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `Test ${tag}`, phone: '+62811',
    },
  });
  // Drop N notifs with monotonic createdAt so newest comes first
  for (let i = 0; i < count; i++) {
    await db.notification.create({
      data: {
        type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
        recipientUserId: user.id, recipientEmail: email,
        body: `notif ${i}`,
        sentAt: new Date(),
        createdAt: new Date(Date.now() - (count - i) * 1000),
      },
    });
  }
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('listMyNotificationsPaginated: returns rows + pagination shape', async (t) => {
  const tag = makeTag('s181-shape');
  const u = await tempUserWithNotifs(t, tag, 3);
  const r = await listMyNotificationsPaginated(u.id, { page: 1, pageSize: 10 });
  assert.equal(r.total, 3);
  assert.equal(r.rows.length, 3);
  assert.equal(r.pagination.page, 1);
  assert.equal(r.pagination.pageSize, 10);
  assert.equal(r.pagination.pageCount, 1);
  // Newest first
  assert.match(r.rows[0].body, /notif 2/);
});

test('listMyNotificationsPaginated: pagination splits across pages', async (t) => {
  const tag = makeTag('s181-pages');
  const u = await tempUserWithNotifs(t, tag, 7);

  const p1 = await listMyNotificationsPaginated(u.id, { page: 1, pageSize: 3 });
  assert.equal(p1.total, 7);
  assert.equal(p1.rows.length, 3);
  assert.equal(p1.pagination.pageCount, 3);
  assert.match(p1.rows[0].body, /notif 6/, 'newest on page 1');

  const p3 = await listMyNotificationsPaginated(u.id, { page: 3, pageSize: 3 });
  assert.equal(p3.rows.length, 1, 'remainder on last page');
});

test('listMyNotificationsPaginated: clamps invalid page params', async (t) => {
  const tag = makeTag('s181-clamp');
  const u = await tempUserWithNotifs(t, tag, 2);

  const r1 = await listMyNotificationsPaginated(u.id, { page: 0 });
  assert.equal(r1.pagination.page, 1, 'page=0 floors to 1');

  const r2 = await listMyNotificationsPaginated(u.id, { page: -5 });
  assert.equal(r2.pagination.page, 1, 'negative page floors to 1');

  const r3 = await listMyNotificationsPaginated(u.id, { pageSize: 999 });
  assert.equal(r3.pagination.pageSize, 100, 'pageSize caps at 100');

  const r4 = await listMyNotificationsPaginated(u.id, { pageSize: -5 });
  assert.equal(r4.pagination.pageSize, 1, 'negative pageSize floors to 1');
});

test('listMyNotificationsPaginated: empty user → total=0, single page', async (t) => {
  const tag = makeTag('s181-empty');
  const u = await tempUserWithNotifs(t, tag, 0);
  const r = await listMyNotificationsPaginated(u.id);
  assert.equal(r.total, 0);
  assert.equal(r.rows.length, 0);
  assert.equal(r.pagination.pageCount, 1, 'empty results still one page');
});
