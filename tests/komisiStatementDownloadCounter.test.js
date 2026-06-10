// Stage 162 — per-surface (agent / admin) download counters on
// KomisiStatement. Fire-and-forget bump via recordStatementDownload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  generateAgentStatement, recordStatementDownload,
} from '../src/services/komisiStatement.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.auditLog.deleteMany({ where: { entity: 'KomisiStatement' } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function seedStatement(t, agentUser) {
  const paket = await tempPaket(t, makeTag('s162-p'));
  const jem = await tempJemaah(t, makeTag('s162-j'));
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });
  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
  return r.statement;
}

test('new statement: counters initialised to 0', async (t) => {
  const tag = makeTag('s162-init');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedStatement(t, agentUser);
  const row = await db.komisiStatement.findUnique({ where: { id: stmt.id } });
  assert.equal(row.agentDownloadCount, 0);
  assert.equal(row.adminDownloadCount, 0);
  assert.equal(row.agentLastDownloadAt, null);
  assert.equal(row.adminLastDownloadAt, null);
});

test('recordStatementDownload: bumps agent counter + stamps timestamp', async (t) => {
  const tag = makeTag('s162-agent');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedStatement(t, agentUser);

  await recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
  const after = await db.komisiStatement.findUnique({ where: { id: stmt.id } });
  assert.equal(after.agentDownloadCount, 1);
  assert.ok(after.agentLastDownloadAt instanceof Date);
  // Admin side unaffected
  assert.equal(after.adminDownloadCount, 0);
  assert.equal(after.adminLastDownloadAt, null);
});

test('recordStatementDownload: bumps admin counter independently', async (t) => {
  const tag = makeTag('s162-admin');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedStatement(t, agentUser);

  await recordStatementDownload({ statementId: stmt.id, surface: 'admin' });
  const after = await db.komisiStatement.findUnique({ where: { id: stmt.id } });
  assert.equal(after.adminDownloadCount, 1);
  assert.ok(after.adminLastDownloadAt instanceof Date);
  assert.equal(after.agentDownloadCount, 0);
});

test('recordStatementDownload: multiple calls cumulate', async (t) => {
  const tag = makeTag('s162-cumulative');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedStatement(t, agentUser);

  await recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
  await recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
  await recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
  const after = await db.komisiStatement.findUnique({ where: { id: stmt.id } });
  assert.equal(after.agentDownloadCount, 3);
});

test('recordStatementDownload: invalid surface → no-op', async (t) => {
  const tag = makeTag('s162-invalid');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedStatement(t, agentUser);

  await recordStatementDownload({ statementId: stmt.id, surface: 'other' });
  const after = await db.komisiStatement.findUnique({ where: { id: stmt.id } });
  assert.equal(after.agentDownloadCount, 0);
  assert.equal(after.adminDownloadCount, 0);
});

test('recordStatementDownload: missing statementId → no-op (no throw)', async () => {
  // Doesn't throw, returns undefined
  await recordStatementDownload({ statementId: null, surface: 'agent' });
  await recordStatementDownload({ surface: 'agent' });
});

test('recordStatementDownload: non-existent statement id → silently swallowed', async () => {
  // Best-effort — a missing row would throw in Prisma, but we catch
  await recordStatementDownload({ statementId: 'does-not-exist-id', surface: 'agent' });
  // No assertion needed — test passes if no throw
});
