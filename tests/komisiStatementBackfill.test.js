// Stage 153 — komisi statement backfill. Walks backwards from previous
// month for `months` periods, idempotent via the existing skip-if-exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { backfillKomisiStatements } from '../src/services/komisiStatement.js';
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

test('backfillKomisiStatements: walks N months backwards from previous month', async (t) => {
  const tag = makeTag('s153-walk');
  await tempAgent(t, tag);  // give us an active agent in the pool

  const now = new Date('2026-06-09T12:00:00Z');  // June 2026
  const r = await backfillKomisiStatements({ months: 3, now });

  // periods should be 2026-05, 2026-04, 2026-03 (previous month + 2 before)
  const periods = r.perMonth.map((m) => m.periodYM);
  assert.deepEqual(periods, ['2026-05', '2026-04', '2026-03']);
  assert.equal(r.monthsRequested, 3);
  // Don't assert on totals — dev DB likely has other agents seeded with
  // pre-existing statements; just verify per-month shape.
});

test('backfillKomisiStatements: caps at 24 months', async () => {
  const r = await backfillKomisiStatements({ months: 200, now: new Date('2026-06-09') });
  assert.equal(r.monthsRequested, 24);
  assert.equal(r.perMonth.length, 24);
});

test('backfillKomisiStatements: floors at 1 month', async () => {
  const r1 = await backfillKomisiStatements({ months: 0, now: new Date('2026-06-09') });
  assert.equal(r1.monthsRequested, 6);  // 0 → falsy → default 6
  const r2 = await backfillKomisiStatements({ months: -5, now: new Date('2026-06-09') });
  // negative → trunc(-5) = -5, max(1, min(24, -5)) = 1
  assert.equal(r2.monthsRequested, 1);
});

test('backfillKomisiStatements: idempotent — second pass skips existing', async (t) => {
  const tag = makeTag('s153-idem');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Seed earned komisi in March 2026
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-03-15') },
  });

  const now = new Date('2026-06-09');
  // First pass: should create (at least) the 2026-03 statement for our agent
  const r1 = await backfillKomisiStatements({ months: 4, now });
  // Find OUR agent's row for 2026-03 — should now exist
  const ourStmt = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId: agentUser.agent.id, periodYM: '2026-03' } },
  });
  assert.ok(ourStmt);
  // Clean the PDF afterward
  t.after(() => { try { if (ourStmt.pdfPath) rmSync(ourStmt.pdfPath); } catch {} });

  // Second pass: same window, expect to skip the existing one
  const r2 = await backfillKomisiStatements({ months: 4, now });
  // Find the per-month report row for 2026-03 — should have at least 1 skipped
  const march2 = r2.perMonth.find((m) => m.periodYM === '2026-03');
  assert.ok(march2);
  assert.ok(march2.skipped >= 1, 'second pass skipped our agent\'s existing statement');
});
