// Stage 150 — monthly per-agent komisi statement. Aggregates EARNED +
// PAID komisi rows in a YYYY-MM window, renders PDF, stores under
// private/komisi-statements/, records KomisiStatement row. Idempotent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  generateAgentStatement, generateAllAgentStatements,
  previousMonthYM, getStatementLines, listAgentStatements,
} from '../src/services/komisiStatement.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: {
        create: {
          displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE',
          whatsapp: '+62811',
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, agent: user.agent };
}

async function tempEarnedKomisi(t, { agentId, bookingId, amount = 100_000, earnedAt = new Date() }) {
  return db.komisi.create({
    data: {
      agentId, bookingId,
      amount: amount.toFixed(2),
      currency: 'IDR', status: 'EARNED',
      earnedAt,
    },
  });
}

test('previousMonthYM: returns YYYY-MM for last calendar month', () => {
  assert.equal(previousMonthYM(new Date('2026-06-09')), '2026-05');
  assert.equal(previousMonthYM(new Date('2026-01-05')), '2025-12');
  assert.equal(previousMonthYM(new Date('2026-12-31')), '2026-11');
});

test('getStatementLines: aggregates EARNED + PAID within window', async (t) => {
  const tag = makeTag('s150-lines');
  const { agent } = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await tempEarnedKomisi(t, {
    agentId: agent.id, bookingId: booking.id, amount: 200_000,
    earnedAt: new Date('2026-05-15'),
  });
  await tempEarnedKomisi(t, {
    agentId: agent.id, bookingId: booking.id, amount: 50_000,
    earnedAt: new Date('2026-04-30'),  // out of window
  });

  const r = await getStatementLines({ agentId: agent.id, periodYM: '2026-05' });
  // Only the in-window row counts
  const ours = r.lines.filter((l) => l.booking?.id === booking.id);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].status, 'EARNED');
});

test('getStatementLines: excludes CANCELLED komisi (undone work)', async (t) => {
  const tag = makeTag('s150-cancelled');
  const { agent } = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const earned = await tempEarnedKomisi(t, {
    agentId: agent.id, bookingId: booking.id,
    earnedAt: new Date('2026-05-15'),
  });
  // Flip to CANCELLED
  await db.komisi.update({ where: { id: earned.id }, data: { status: 'CANCELLED' } });

  const r = await getStatementLines({ agentId: agent.id, periodYM: '2026-05' });
  const found = r.lines.find((l) => l.id === earned.id);
  assert.equal(found, undefined);
});

test('generateAgentStatement: creates DB row + PDF on first call', async (t) => {
  const tag = makeTag('s150-gen');
  const { agent } = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await tempEarnedKomisi(t, {
    agentId: agent.id, bookingId: booking.id, amount: 250_000,
    earnedAt: new Date('2026-05-15'),
  });

  const r = await generateAgentStatement({ agentId: agent.id, periodYM: '2026-05' });
  assert.equal(r.created, true);
  assert.ok(r.statement.id);
  assert.equal(r.statement.periodYM, '2026-05');
  assert.equal(r.statement.lineCount, 1);
  assert.equal(Number(r.statement.totalEarnedIdr.toString()), 250_000);
  assert.ok(r.pdfPath);
  assert.ok(existsSync(r.pdfPath));

  // PDF magic bytes
  const buf = readFileSync(r.pdfPath);
  assert.equal(buf.slice(0, 4).toString(), '%PDF');

  t.after(() => { try { rmSync(r.pdfPath); } catch {} });
});

test('generateAgentStatement: idempotent — second call returns existing', async (t) => {
  const tag = makeTag('s150-idem');
  const { agent } = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tempEarnedKomisi(t, { agentId: agent.id, bookingId: booking.id,
    earnedAt: new Date('2026-05-15') });

  const r1 = await generateAgentStatement({ agentId: agent.id, periodYM: '2026-05' });
  assert.equal(r1.created, true);
  const r2 = await generateAgentStatement({ agentId: agent.id, periodYM: '2026-05' });
  assert.equal(r2.created, false, 'second call → idempotent');
  assert.equal(r2.statement.id, r1.statement.id);

  t.after(() => { try { rmSync(r1.pdfPath); } catch {} });
});

test('generateAllAgentStatements: batches across active agents + counts skips', async (t) => {
  const tag = makeTag('s150-batch');
  const { agent: agentA } = await tempAgent(t, `${tag}-a`);
  const { agent: agentB } = await tempAgent(t, `${tag}-b`);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tempEarnedKomisi(t, { agentId: agentA.id, bookingId: booking.id,
    earnedAt: new Date('2026-05-15') });

  // Pre-create for agentB so it's a skip
  await db.komisiStatement.create({
    data: {
      agentId: agentB.id, periodYM: '2026-05',
      totalEarnedIdr: 0, totalPaidIdr: 0, lineCount: 0,
    },
  });

  const r = await generateAllAgentStatements({ periodYM: '2026-05' });
  // Both our agents counted somewhere (other agents in dev DB also included)
  assert.ok(r.created >= 1);
  assert.ok(r.skipped >= 1);

  t.after(async () => {
    const aStmt = await db.komisiStatement.findFirst({
      where: { agentId: agentA.id, periodYM: '2026-05' },
    });
    if (aStmt?.pdfPath) { try { rmSync(aStmt.pdfPath); } catch {} }
  });
});

test('listAgentStatements: returns per-agent descending by period', async (t) => {
  const tag = makeTag('s150-list');
  const { agent } = await tempAgent(t, tag);
  // Seed two statements
  await db.komisiStatement.create({
    data: { agentId: agent.id, periodYM: '2026-04',
            totalEarnedIdr: 100, totalPaidIdr: 0, lineCount: 1 },
  });
  await db.komisiStatement.create({
    data: { agentId: agent.id, periodYM: '2026-05',
            totalEarnedIdr: 200, totalPaidIdr: 0, lineCount: 2 },
  });

  const r = await listAgentStatements({ agentId: agent.id });
  assert.ok(r.length >= 2);
  // Descending — newest period first
  assert.equal(r[0].periodYM, '2026-05');
  assert.equal(r[1].periodYM, '2026-04');
});
