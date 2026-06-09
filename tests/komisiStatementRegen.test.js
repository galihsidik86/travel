// Stage 151 — admin regenerate of a komisi statement. Deletes existing
// row + PDF, re-renders from current komisi data, writes audit row
// with prior totals so compliance can answer "did the number change?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempUser, fakeReq } from './_helpers.js';
import {
  generateAgentStatement, regenerateAgentStatement,
} from '../src/services/komisiStatement.js';
import { hashPassword } from '../src/lib/auth.js';
import { HttpError } from '../src/middleware/error.js';

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
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.auditLog.deleteMany({ where: { entity: 'KomisiStatement' } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('regenerateAgentStatement: produces fresh PDF + audit row with prior totals', async (t) => {
  const tag = makeTag('s151-regen');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // First komisi → first statement
  const k1 = await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15'),
    },
  });
  const r1 = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  const priorPdfPath = r1.pdfPath;
  assert.equal(Number(r1.statement.totalEarnedIdr.toString()), 100_000);
  assert.ok(existsSync(priorPdfPath));
  const priorPdfSize = readFileSync(priorPdfPath).length;

  // Late adjustment — add another komisi for the same period
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '50000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-20'),
    },
  });

  const r2 = await regenerateAgentStatement({
    req: fakeReq,
    actor: { id: owner.id, email: owner.email, role: 'OWNER' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  // Fresh statement totals reflect the new komisi
  assert.equal(r2.regenerated, true);
  assert.equal(Number(r2.statement.totalEarnedIdr.toString()), 150_000);
  assert.equal(r2.statement.lineCount, 2);
  // Filename is <agentId>__<period>.pdf so the path stays the same, but
  // the underlying bytes change (more rows → larger PDF in practice).
  assert.equal(r2.pdfPath, priorPdfPath);
  assert.ok(existsSync(r2.pdfPath));
  const newPdfSize = readFileSync(r2.pdfPath).length;
  assert.notEqual(newPdfSize, priorPdfSize, 'PDF bytes regenerated (size differs)');

  // Audit row carries prior totals
  const audits = await db.auditLog.findMany({
    where: { entity: 'KomisiStatement', entityId: r2.statement.id, action: 'UPDATE' },
  });
  assert.ok(audits.length >= 1);
  const audit = audits[0];
  assert.equal(audit.after.regenerated, true);
  assert.equal(audit.before.totalEarnedIdr, 100_000);
  assert.equal(audit.after.totalEarnedIdr, 150_000);

  t.after(() => { try { rmSync(r2.pdfPath); } catch {} });
});

test('regenerateAgentStatement: missing prior row → still works (no-op delete + generate)', async (t) => {
  const tag = makeTag('s151-fresh');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
            amount: '75000', currency: 'IDR', status: 'EARNED',
            earnedAt: new Date('2026-05-10') },
  });

  const r = await regenerateAgentStatement({
    req: fakeReq, actor: { id: owner.id, email: owner.email, role: 'OWNER' },
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  assert.equal(r.regenerated, true);
  assert.equal(r.prior, null, 'no prior to capture');
  assert.equal(Number(r.statement.totalEarnedIdr.toString()), 75_000);
  // Audit before-payload reflects the absent-prior signal
  const audits = await db.auditLog.findMany({
    where: { entity: 'KomisiStatement', entityId: r.statement.id, action: 'UPDATE' },
  });
  assert.equal(audits[0].before.existed, false);

  t.after(() => { try { rmSync(r.pdfPath); } catch {} });
});

test('regenerateAgentStatement: rejects malformed periodYM', async () => {
  await assert.rejects(
    () => regenerateAgentStatement({ agentId: 'bogus', periodYM: '2026/5' }),
    (err) => err instanceof HttpError && err.code === 'BAD_PERIOD',
  );
});

test('regenerateAgentStatement: rejects missing agentId', async () => {
  await assert.rejects(
    () => regenerateAgentStatement({ periodYM: '2026-05' }),
    (err) => err instanceof HttpError && err.code === 'BAD_AGENT',
  );
});
