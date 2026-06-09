// Stage 156 — optional admin note attached to a komisi statement.
// Renders as bordered block on the PDF. Trim + cap 2000 chars
// defensively. Regenerate path with `undefined` preserves prior note;
// empty string / null clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq } from './_helpers.js';
import {
  generateAgentStatement, regenerateAgentStatement, listAgentStatements,
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

test('generateAgentStatement: persists adminNote on the row', async (t) => {
  const tag = makeTag('s156-create');
  const agentUser = await tempAgent(t, tag);

  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: '  Bonus tertahan Rp 500rb, akan diterbitkan bulan depan.  ',
  });
  assert.equal(r.created, true);
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });

  const row = await db.komisiStatement.findUnique({ where: { id: r.statement.id } });
  // Trimmed
  assert.equal(row.adminNote, 'Bonus tertahan Rp 500rb, akan diterbitkan bulan depan.');
});

test('generateAgentStatement: empty / null note → adminNote stays null', async (t) => {
  const tag = makeTag('s156-null');
  const agentUser = await tempAgent(t, tag);

  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: '',  // explicit empty
  });
  t.after(() => { try { if (r1.pdfPath) rmSync(r1.pdfPath); } catch {} });
  assert.equal(r1.statement.adminNote, null);
});

test('generateAgentStatement: caps adminNote at 2000 chars', async (t) => {
  const tag = makeTag('s156-cap');
  const agentUser = await tempAgent(t, tag);
  const big = 'A'.repeat(5000);

  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: big,
  });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
  assert.equal(r.statement.adminNote.length, 2000);
});

test('regenerateAgentStatement: explicit adminNote replaces prior', async (t) => {
  const tag = makeTag('s156-replace');
  const agentUser = await tempAgent(t, tag);

  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: 'Old note',
  });
  t.after(() => { try { if (r1.pdfPath) rmSync(r1.pdfPath); } catch {} });

  const r2 = await regenerateAgentStatement({
    req: fakeReq, actor: { email: 'admin' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: 'New note',
  });
  t.after(() => { try { if (r2.pdfPath) rmSync(r2.pdfPath); } catch {} });
  assert.equal(r2.statement.adminNote, 'New note');
});

test('regenerateAgentStatement: undefined adminNote preserves prior', async (t) => {
  const tag = makeTag('s156-preserve');
  const agentUser = await tempAgent(t, tag);

  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: 'Sticky note',
  });
  t.after(() => { try { if (r1.pdfPath) rmSync(r1.pdfPath); } catch {} });

  // No adminNote in regen call → preserve
  const r2 = await regenerateAgentStatement({
    req: fakeReq, actor: { email: 'admin' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
    // adminNote omitted (undefined)
  });
  t.after(() => { try { if (r2.pdfPath) rmSync(r2.pdfPath); } catch {} });
  assert.equal(r2.statement.adminNote, 'Sticky note', 'undefined → preserve prior');
});

test('regenerateAgentStatement: empty string adminNote clears prior', async (t) => {
  const tag = makeTag('s156-clear');
  const agentUser = await tempAgent(t, tag);

  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: 'To be cleared',
  });
  t.after(() => { try { if (r1.pdfPath) rmSync(r1.pdfPath); } catch {} });

  const r2 = await regenerateAgentStatement({
    req: fakeReq, actor: { email: 'admin' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: '',  // explicit clear
  });
  t.after(() => { try { if (r2.pdfPath) rmSync(r2.pdfPath); } catch {} });
  assert.equal(r2.statement.adminNote, null, 'empty string → clear');
});

test('listAgentStatements: includes adminNote so wallet badge can render', async (t) => {
  const tag = makeTag('s156-list');
  const agentUser = await tempAgent(t, tag);

  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
    adminNote: 'Lihat detail di PDF.',
  });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });

  const rows = await listAgentStatements({ agentId: agentUser.agent.id });
  const ours = rows.find((s) => s.id === r.statement.id);
  assert.ok(ours);
  assert.equal(ours.adminNote, 'Lihat detail di PDF.');
});
