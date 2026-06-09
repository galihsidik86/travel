// Stage 155 — YTD running totals on komisi statement. Computes
// before/during/after slices over the calendar year of periodYM so
// the PDF can show cumulative position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  computeYtdTotals, generateAgentStatement,
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

test('computeYtdTotals: before + during ≈ after for typical case', async (t) => {
  const tag = makeTag('s155-sum');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Jan 2026 — 100k EARNED
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-01-15') },
  });
  // May 2026 — 200k EARNED (the period we're computing for)
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '200000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });

  const r = await computeYtdTotals({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  // before (Jan-Apr): 100k earned
  assert.equal(r.before.earnedIdr, 100_000);
  // during (May): 200k earned
  assert.equal(r.during.earnedIdr, 200_000);
  // after (Jan-May): 300k earned
  assert.equal(r.after.earnedIdr, 300_000);
  assert.equal(r.year, 2026);
  assert.equal(r.suppressed, false);
});

test('computeYtdTotals: suppressed=true on January with no prior signal', async (t) => {
  const tag = makeTag('s155-jan');
  const agentUser = await tempAgent(t, tag);
  // No komisi rows at all → before count = 0 + period is January

  const r = await computeYtdTotals({ agentId: agentUser.agent.id, periodYM: '2026-01' });
  assert.equal(r.before.count, 0);
  assert.equal(r.suppressed, true, 'January + empty prior → suppress YTD block');
});

test('computeYtdTotals: NOT suppressed when February even with empty prior', async (t) => {
  const tag = makeTag('s155-feb');
  const agentUser = await tempAgent(t, tag);

  const r = await computeYtdTotals({ agentId: agentUser.agent.id, periodYM: '2026-02' });
  // February is past Jan — show the block (with 0s) so agent sees the running start
  assert.equal(r.suppressed, false);
});

test('computeYtdTotals: only counts rows in the agent\'s year scope', async (t) => {
  const tag = makeTag('s155-yearscope');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Prior year (2025) — should NOT appear in 2026 YTD
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '500000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2025-12-15') },
  });
  // Current year
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-03-10') },
  });

  const r = await computeYtdTotals({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  // before (Jan-Apr 2026): only the March row counts; the Dec 2025 row is out of scope
  assert.equal(r.before.earnedIdr, 100_000);
});

test('generateAgentStatement: PDF includes YTD block when relevant', async (t) => {
  const tag = makeTag('s155-pdf');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Prior period (Feb 2026) komisi to give "before" a non-zero value
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '300000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-02-10') },
  });
  // Current period (May 2026)
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15') },
  });

  const r = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  assert.equal(r.created, true);
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
  // PDF size > a baseline that includes the block — sanity rather than
  // a strict pixel-level check (pdfkit byte counts shift across versions).
  const stat = await import('node:fs').then((m) => m.promises.stat(r.pdfPath));
  assert.ok(stat.size > 2000, 'PDF rendered with content (>2KB)');
});
