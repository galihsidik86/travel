// Stage 164 — paginated full statement history for /agen/statements +
// Stage 165 — CSV export of a single period's komisi lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  generateAgentStatement, listAgentStatementsPaginated, buildStatementCsv,
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

async function seedStatement(t, agentUser, periodYM, amount = '100000') {
  const tag = makeTag(`s164-${periodYM}`);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const earnedAt = new Date(`${periodYM}-15`);
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount, currency: 'IDR', status: 'EARNED', earnedAt,
    },
  });
  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
  return r.statement;
}

test('listAgentStatementsPaginated: returns rows + lifetime totals + pagination', async (t) => {
  const tag = makeTag('s164-basic');
  const agentUser = await tempAgent(t, tag);
  await seedStatement(t, agentUser, '2026-05', '100000');
  await seedStatement(t, agentUser, '2026-04', '200000');
  await seedStatement(t, agentUser, '2026-03', '300000');

  const r = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, page: 1, pageSize: 10 });
  assert.equal(r.total, 3);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].periodYM, '2026-05', 'newest first');
  assert.equal(r.rows[2].periodYM, '2026-03');
  assert.equal(r.lifetime.earnedIdr, 600_000);
  assert.equal(r.lifetime.statementCount, 3);
  assert.equal(r.lifetime.lineCount, 3);
  assert.equal(r.pagination.page, 1);
  assert.equal(r.pagination.pageCount, 1);
});

test('listAgentStatementsPaginated: pagination splits across pages', async (t) => {
  const tag = makeTag('s164-pages');
  const agentUser = await tempAgent(t, tag);
  for (const p of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
    await seedStatement(t, agentUser, p, '50000');
  }
  const p1 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, page: 1, pageSize: 2 });
  assert.equal(p1.total, 5);
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.pagination.pageCount, 3);
  assert.equal(p1.rows[0].periodYM, '2026-05');

  const p2 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, page: 2, pageSize: 2 });
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.rows[0].periodYM, '2026-03');

  const p3 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, page: 3, pageSize: 2 });
  assert.equal(p3.rows.length, 1);
  assert.equal(p3.rows[0].periodYM, '2026-01');
});

test('listAgentStatementsPaginated: clamps invalid page params to safe defaults', async (t) => {
  const tag = makeTag('s164-clamp');
  const agentUser = await tempAgent(t, tag);
  await seedStatement(t, agentUser, '2026-05', '100000');

  // page=0 → clamps to 1
  const r1 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, page: 0 });
  assert.equal(r1.pagination.page, 1);

  // pageSize=999 → clamps to 100
  const r2 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, pageSize: 999 });
  assert.equal(r2.pagination.pageSize, 100);

  // pageSize=-5 → clamps to 1 (floor)
  const r3 = await listAgentStatementsPaginated({ agentId: agentUser.agent.id, pageSize: -5 });
  assert.equal(r3.pagination.pageSize, 1);
});

test('listAgentStatementsPaginated: empty agent → zero lifetime totals', async (t) => {
  const tag = makeTag('s164-empty');
  const agentUser = await tempAgent(t, tag);
  const r = await listAgentStatementsPaginated({ agentId: agentUser.agent.id });
  assert.equal(r.total, 0);
  assert.equal(r.rows.length, 0);
  assert.equal(r.lifetime.earnedIdr, 0);
  assert.equal(r.lifetime.statementCount, 0);
});

test('buildStatementCsv: BOM + header + footer + RFC 4180 quoting', async (t) => {
  const tag = makeTag('s165-csv');
  const agentUser = await tempAgent(t, tag);
  await seedStatement(t, agentUser, '2026-05', '150000');

  const r = await buildStatementCsv({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r.lineCount, 1);
  // UTF-8 BOM
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM prefix');
  // Header columns
  assert.match(r.csv, /bookingNo,jemaahName,paketTitle/);
  // Amount appears as numeric
  assert.match(r.csv, /150000/);
  // EARNED status surfaced
  assert.match(r.csv, /EARNED/);
  // Footer total marker
  assert.match(r.csv, /TOTAL/);
  // CRLF row separators (RFC 4180)
  assert.match(r.csv, /\r\n/);
});

test('buildStatementCsv: empty period → header + footer only, lineCount=0', async (t) => {
  const tag = makeTag('s165-empty-csv');
  const agentUser = await tempAgent(t, tag);

  const r = await buildStatementCsv({ agentId: agentUser.agent.id, periodYM: '2099-01' });
  assert.equal(r.lineCount, 0);
  assert.match(r.csv, /bookingNo,jemaahName/);
  assert.match(r.csv, /TOTAL/);
});

test('buildStatementCsv: special chars (commas, quotes) properly escaped', async (t) => {
  const tag = makeTag('s165-esc');
  const agentUser = await tempAgent(t, tag);
  // Create a jemaah with a comma in the name
  const paket = await tempPaket(t, makeTag('s165-esc-p'));
  const jem = await db.jemaahProfile.create({
    data: { fullName: 'Ahmad, "the agent"', phone: '+62811-9999' },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { booking: { jemaahId: jem.id } } });
    await db.booking.deleteMany({ where: { jemaahId: jem.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15'),
    },
  });

  const r = await buildStatementCsv({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  // Comma-bearing name must be wrapped in double-quotes
  assert.match(r.csv, /"Ahmad, ""the agent"""/);
});
