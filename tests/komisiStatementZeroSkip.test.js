// Stage 154 — env-gated KOMISI_STATEMENT_SKIP_ZERO_LINES makes cron /
// backfill skip zero-line agents entirely (no DB row, no PDF). Admin
// regenerate ignores the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq } from './_helpers.js';
import {
  generateAllAgentStatements, generateAgentStatement, regenerateAgentStatement,
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

test('generateAllAgentStatements: SKIP flag prevents zero-line row creation', async (t) => {
  const tag = makeTag('s154-skip');
  const agentUser = await tempAgent(t, tag);
  // No komisi rows for this agent → zero lines for any period

  process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES = 'true';
  t.after(() => { delete process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES; });

  const r = await generateAllAgentStatements({ periodYM: '2026-05' });
  assert.ok(r.zeroSkipped >= 1, `our agent counted in zeroSkipped (got ${r.zeroSkipped})`);

  // No DB row for our agent
  const stmt = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId: agentUser.agent.id, periodYM: '2026-05' } },
  });
  assert.equal(stmt, null, 'no row created for zero-line agent under SKIP flag');
});

test('generateAllAgentStatements: WITHOUT SKIP flag, zero-line row IS created (back-compat)', async (t) => {
  const tag = makeTag('s154-default');
  const agentUser = await tempAgent(t, tag);

  // Ensure flag is OFF
  delete process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES;

  const r = await generateAllAgentStatements({ periodYM: '2026-05' });
  // zeroSkipped should be 0 for OUR agent — the flag is off
  const stmt = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId: agentUser.agent.id, periodYM: '2026-05' } },
  });
  assert.ok(stmt, 'zero-line row WAS created when flag is off');
  assert.equal(stmt.lineCount, 0);
  t.after(() => { try { if (stmt.pdfPath) rmSync(stmt.pdfPath); } catch {} });
});

test('generateAllAgentStatements: SKIP flag still respects existing row (idempotency wins)', async (t) => {
  const tag = makeTag('s154-existing');
  const agentUser = await tempAgent(t, tag);

  // Pre-seed an existing statement for this period
  await db.komisiStatement.create({
    data: {
      agentId: agentUser.agent.id, periodYM: '2026-05',
      totalEarnedIdr: 0, totalPaidIdr: 0, lineCount: 0,
    },
  });

  process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES = 'true';
  t.after(() => { delete process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES; });

  const r = await generateAllAgentStatements({ periodYM: '2026-05' });
  // The agent should count under `skipped` (existing), not `zeroSkipped`
  // — once a row exists the SKIP flag stops mattering.
  const stmt = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId: agentUser.agent.id, periodYM: '2026-05' } },
  });
  assert.ok(stmt, 'existing row preserved');
});

test('generateAgentStatement (direct call): SKIP flag ignored — always creates', async (t) => {
  const tag = makeTag('s154-direct');
  const agentUser = await tempAgent(t, tag);

  process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES = 'true';
  t.after(() => { delete process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES; });

  // Direct call (admin path, not cron) — always creates regardless of flag
  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  assert.equal(r.created, true, 'direct generate ignores SKIP flag (admin intent)');
  assert.equal(r.statement.lineCount, 0);
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
});

test('regenerateAgentStatement: SKIP flag ignored — admin override always produces', async (t) => {
  const tag = makeTag('s154-regen');
  const agentUser = await tempAgent(t, tag);

  // Pre-seed via direct generate (so prior row exists)
  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  t.after(() => { try { if (r1.pdfPath) rmSync(r1.pdfPath); } catch {} });
  assert.equal(r1.created, true);

  // Now flip flag ON and regenerate — should still produce
  process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES = 'true';
  t.after(() => { delete process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES; });

  const r2 = await regenerateAgentStatement({
    req: fakeReq, actor: { email: 'test-admin' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  assert.equal(r2.regenerated, true);
  assert.ok(r2.statement, 'admin regenerate produces statement even when SKIP flag set');
  t.after(() => { try { if (r2.pdfPath) rmSync(r2.pdfPath); } catch {} });
});
