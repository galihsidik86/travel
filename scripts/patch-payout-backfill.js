// =============================================================
// Religio Pro — demo-realism patch #3: payout reconciliation
//
// seed-demo-realistic.js's makeBooking() had a 70% chance of stamping
// LUNAS-on-closed-paket komisi directly as status='PAID' (simulating
// "already paid out historically") without creating a matching
// KomisiPayout row. Only the remaining 30% ('EARNED') got swept into
// the one explicit payout created for bambang-s. Result: every other
// agent's wallet shows "Sudah dicairkan Rp X" with an empty or
// incomplete "Riwayat payout" table — a reconciliation gap a client
// could click into and notice.
//
// This backfills one KomisiPayout per agent bundling their orphan
// PAID komisi rows, dated shortly after the earliest orphan row's
// earnedAt (mimicking a real payout batch run).
//
// Usage: node --env-file-if-exists=.env scripts/patch-payout-backfill.js
// =============================================================

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
function idr(n) { return Math.round(n).toFixed(2); }

async function main() {
  const owner = await db.user.findUnique({ where: { email: 'owner@religio.pro' } });
  const orphans = await db.komisi.findMany({
    where: { status: 'PAID', payoutId: null },
    include: { agent: { select: { id: true, slug: true } } },
  });
  const byAgent = new Map();
  for (const k of orphans) {
    if (!byAgent.has(k.agentId)) byAgent.set(k.agentId, []);
    byAgent.get(k.agentId).push(k);
  }
  if (!byAgent.size) { console.log('no orphan PAID komisi found — nothing to backfill'); return; }

  let payoutCount = await db.komisiPayout.count();
  for (const [agentId, rows] of byAgent) {
    const sum = rows.reduce((s, k) => s + Number(k.amount), 0);
    const earliestEarned = rows.reduce((min, k) => (k.earnedAt && k.earnedAt < min ? k.earnedAt : min), rows[0].earnedAt ?? new Date());
    const paidAt = new Date(earliestEarned.getTime() + 5 * 86400_000); // paid out ~5 days after earned
    payoutCount++;
    const payout = await db.komisiPayout.create({
      data: {
        payoutNo: `PO-2026-${String(payoutCount).padStart(5, '0')}`,
        agentId, amount: idr(sum), currency: 'IDR',
        method: 'TRANSFER', reference: `BCA-${Math.floor(100000 + Math.random() * 900000)}`,
        notes: 'Payout batch komisi (backfill rekonsiliasi).',
        paidAt, paidById: owner?.id ?? null,
      },
    });
    await db.komisi.updateMany({
      where: { id: { in: rows.map((k) => k.id) } },
      data: { payoutId: payout.id, paidAt },
    });
    console.log(`  ${payout.payoutNo} → agent ${rows[0].agent.slug}: ${rows.length} rows, Rp ${sum.toLocaleString('id-ID')}`);
  }
  console.log(`\nDone. ${byAgent.size} payout(s) backfilled.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
