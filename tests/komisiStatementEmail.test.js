// Stage 152 — KOMISI_STATEMENT_READY email fires when statement is
// generated. Silent on zero-line statements + idempotent re-runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { generateAgentStatement } from '../src/services/komisiStatement.js';
import { notifyKomisiStatementReady } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, { status = 'ACTIVE' } = {}) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811', status,
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

test('notifyKomisiStatementReady: silent on zero-line statement', async () => {
  const r = await notifyKomisiStatementReady({
    statement: { id: 'x', periodYM: '2026-05', totalEarnedIdr: 0, totalPaidIdr: 0, lineCount: 0 },
    agent: { displayName: 'Test', slug: 't', email: 'agen@example.test', userId: null },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'zero_lines');
});

test('notifyKomisiStatementReady: silent when agent has no email', async () => {
  const r = await notifyKomisiStatementReady({
    statement: { id: 'x', periodYM: '2026-05', totalEarnedIdr: 100, totalPaidIdr: 0, lineCount: 1 },
    agent: { displayName: 'Test', slug: 't', email: null, userId: null },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_email');
});

test('generateAgentStatement: fires KOMISI_STATEMENT_READY email on first create with lines > 0', async (t) => {
  const tag = makeTag('s152-fire');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '250000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15'),
    },
  });

  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r.created, true);
  t.after(() => { try { rmSync(r.pdfPath); } catch {} });

  const notifs = await db.notification.findMany({
    where: {
      type: 'KOMISI_STATEMENT_READY',
      recipientUserId: agentUser.id,
      relatedEntity: 'KomisiStatement',
      relatedEntityId: r.statement.id,
    },
  });
  assert.equal(notifs.length, 1);
  assert.match(notifs[0].subject, /2026-05/);
  assert.match(notifs[0].body, /250\.000/);
  assert.match(notifs[0].body, /\/agen\/statements\/.+\.pdf/);
});

test('generateAgentStatement: NO notif on idempotent second call', async (t) => {
  const tag = makeTag('s152-idem');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10'),
    },
  });

  const r1 = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r1.created, true);
  t.after(() => { try { rmSync(r1.pdfPath); } catch {} });

  const after1 = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  // Second call → no new notif (idempotent path returns early)
  const r2 = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r2.created, false);
  const after2 = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  assert.equal(after2, after1, 'no duplicate notif on idempotent re-run');
});

test('generateAgentStatement: NO notif when agent suspended', async (t) => {
  const tag = makeTag('s152-suspended');
  const agentUser = await tempAgent(t, tag, { status: 'SUSPENDED' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10'),
    },
  });

  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r.created, true);
  t.after(() => { try { rmSync(r.pdfPath); } catch {} });

  const count = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  assert.equal(count, 0, 'suspended agent doesnt get notif');
});

test('generateAgentStatement: NO notif when zero lines (silent month)', async (t) => {
  const tag = makeTag('s152-zero');
  const agentUser = await tempAgent(t, tag);
  // No komisi rows for this period → zero-line statement
  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r.created, true);
  assert.equal(r.statement.lineCount, 0);
  t.after(() => { try { rmSync(r.pdfPath); } catch {} });

  const count = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  assert.equal(count, 0, 'no notif on silent month');
});
