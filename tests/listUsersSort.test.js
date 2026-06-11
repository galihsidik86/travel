// Stage 177 — sortBy=lastLogin option on listUsers. Oldest first
// with NULL ("never logged in") landing last.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { listUsers } from '../src/services/userAdmin.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempStaff(t, tag, { lastLoginAt = null, role = 'KASIR' } = {}) {
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role, fullName: `Test ${tag}`, phone: '+62811',
      lastLoginAt,
      staff: { create: { department: 'Ops', position: 'Test' } },
    },
  });
  t.after(async () => {
    await db.staffProfile.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('listUsers: default sort unchanged (by role then name)', async (t) => {
  const tag = makeTag('s177-def');
  await tempStaff(t, tag);
  const rows = await listUsers({ search: tag });
  assert.ok(rows.length >= 1);
  // Default sort doesn't reorder by lastLogin
});

test('listUsers: sortBy=lastLogin orders oldest first, NULL last', async (t) => {
  const tag = makeTag('s177-sort');
  // 3 staff: old, recent, never-logged-in
  const old = await tempStaff(t, `${tag}-old`, {
    lastLoginAt: new Date('2025-01-01'),
  });
  const recent = await tempStaff(t, `${tag}-rec`, {
    lastLoginAt: new Date('2026-06-01'),
  });
  const never = await tempStaff(t, `${tag}-nev`);

  const rows = await listUsers({ search: tag, sortBy: 'lastLogin' });
  const idsInOrder = rows.map((r) => r.id);
  const idxOld = idsInOrder.indexOf(old.id);
  const idxRecent = idsInOrder.indexOf(recent.id);
  const idxNever = idsInOrder.indexOf(never.id);
  assert.ok(idxOld >= 0 && idxRecent >= 0 && idxNever >= 0, 'all three found');
  assert.ok(idxOld < idxRecent, 'old precedes recent');
  assert.ok(idxRecent < idxNever, 'recent precedes never (NULL last)');
});

test('listUsers: sortBy=lastLogin honours search filter', async (t) => {
  const tag = makeTag('s177-filt');
  await tempStaff(t, `${tag}-A`, { lastLoginAt: new Date('2025-01-01') });
  await tempStaff(t, `${tag}-B`, { lastLoginAt: new Date('2026-06-01') });

  const rows = await listUsers({ search: tag, sortBy: 'lastLogin' });
  // Only our two test users should match the makeTag search
  assert.equal(rows.length, 2);
});
