import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { pruneRetentionWindows } from '../src/services/retention.js';

// Helper: create a JEMAAH with custom createdAt / lastLoginAt
async function makeJemaah(t, tag, { ageDays = 0, lastLoginDaysAgo = null } = {}) {
  const createdAt = new Date(Date.now() - ageDays * 86_400_000);
  const lastLoginAt = lastLoginDaysAgo != null
    ? new Date(Date.now() - lastLoginDaysAgo * 86_400_000)
    : null;
  const email = `${tag}@example.test`;
  const u = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'JEMAAH',
      fullName: `Jem ${tag}`, phone: '+62811',
      createdAt, lastLoginAt,
      jemaah: { create: { fullName: `Jem ${tag}`, phone: '+62811' } },
    },
    include: { jemaah: true },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { jemaahUserId: u.id } });
    await db.jemaahProfile.deleteMany({ where: { id: u.jemaah.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

test('pruneInactiveJemaah: soft-deletes account aged 400d with no bookings + no login', async (t) => {
  const tag = makeTag('pr-old');
  const u = await makeJemaah(t, tag, { ageDays: 400, lastLoginDaysAgo: null });

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: u.id }, select: { deletedAt: true } });
  assert.ok(after.deletedAt instanceof Date, 'should be soft-deleted');
});

test('pruneInactiveJemaah: skips young account (createdAt < cutoff fails)', async (t) => {
  const tag = makeTag('pr-young');
  const u = await makeJemaah(t, tag, { ageDays: 30, lastLoginDaysAgo: null });

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: u.id }, select: { deletedAt: true } });
  assert.equal(after.deletedAt, null, '30d-old account must NOT be touched');
});

test('pruneInactiveJemaah: skips account with recent login', async (t) => {
  const tag = makeTag('pr-recent');
  const u = await makeJemaah(t, tag, { ageDays: 400, lastLoginDaysAgo: 10 });

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: u.id }, select: { deletedAt: true } });
  assert.equal(after.deletedAt, null, 'recently-logged-in account must NOT be touched');
});

test('pruneInactiveJemaah: skips account with active booking', async (t) => {
  const tag = makeTag('pr-bk');
  const u = await makeJemaah(t, tag, { ageDays: 400, lastLoginDaysAgo: null });
  const paket = await tempPaket(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id,
      jemaahId: u.jemaah.id, jemaahUserId: u.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'BOOKED',
    },
  });

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: u.id }, select: { deletedAt: true } });
  assert.equal(after.deletedAt, null, 'account with active booking must NOT be touched');
});

test('pruneInactiveJemaah: cancelled-only booking does NOT save the account', async (t) => {
  const tag = makeTag('pr-cx');
  const u = await makeJemaah(t, tag, { ageDays: 400, lastLoginDaysAgo: null });
  const paket = await tempPaket(t, tag);
  // Cancelled booking only — shouldn't keep the account alive
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-CX`, paketId: paket.id,
      jemaahId: u.jemaah.id, jemaahUserId: u.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
    },
  });

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: u.id }, select: { deletedAt: true } });
  assert.ok(after.deletedAt instanceof Date, 'CANCELLED booking does not save the account');
});

test('pruneInactiveJemaah: does NOT touch OWNER/AGEN users (role gate)', async (t) => {
  const tag = makeTag('pr-other');
  const adminEmail = `${tag}-o@example.test`;
  const owner = await db.user.create({
    data: {
      email: adminEmail, passwordHash: await hashPassword('test12345'), role: 'OWNER',
      fullName: `Old Owner ${tag}`, phone: '+62811',
      createdAt: new Date(Date.now() - 400 * 86_400_000),
      lastLoginAt: null,
    },
  });
  t.after(() => db.user.deleteMany({ where: { id: owner.id } }));

  await pruneRetentionWindows({ actor: { email: 'system' } });

  const after = await db.user.findUnique({ where: { id: owner.id }, select: { deletedAt: true } });
  assert.equal(after.deletedAt, null, 'OWNER account must NEVER be auto-pruned');
});
