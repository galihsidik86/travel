// Stage 41 — komisi liability aging. Bucket EARNED komisi by how long
// they've been waiting (from `earnedAt`) so admins see at a glance which
// agents have been waiting the longest for payout.
//
// Buckets: 0-30 days / 30-60 / 60-90 / 90+. Anything in 90+ is a serious
// trust signal — agents who waited 3+ months for komisi are likely to
// disengage from the platform.
//
// Pairs with Stage 37 (smart payout reminder): the reminder says WHO
// crosses a Rupiah threshold; this report says WHO has been waiting
// the longest, even if the amount is small.

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const ONE_DAY_MS = 86_400_000;

const BUCKETS = [
  { key: '0-30',   minDays: 0,   maxDays: 30,  label: '<30 hari'    },
  { key: '30-60',  minDays: 30,  maxDays: 60,  label: '30-60 hari'  },
  { key: '60-90',  minDays: 60,  maxDays: 90,  label: '60-90 hari'  },
  { key: '90+',    minDays: 90,  maxDays: null, label: '90+ hari'   },
];

function bucketFor(days) {
  for (const b of BUCKETS) {
    if (days >= b.minDays && (b.maxDays == null || days < b.maxDays)) return b.key;
  }
  return '0-30';
}

export async function getKomisiAging({ now = new Date() } = {}) {
  const earned = await db.komisi.findMany({
    where: { status: 'EARNED' },
    select: {
      agentId: true, amount: true, earnedAt: true,
      agent: { select: { slug: true, displayName: true } },
    },
  });

  // Per-agent rollup keyed on agentId
  const byAgent = new Map();
  // Per-bucket totals across the whole system
  const totals = Object.fromEntries(BUCKETS.map((b) => [b.key, { count: 0, amountIdr: 0 }]));

  for (const k of earned) {
    if (!k.agentId || !k.earnedAt) continue;
    const ageDays = Math.floor((now.getTime() - k.earnedAt.getTime()) / ONE_DAY_MS);
    const bucket = bucketFor(ageDays);
    const amount = toNumber(k.amount) ?? 0;

    totals[bucket].count += 1;
    totals[bucket].amountIdr += amount;

    const row = byAgent.get(k.agentId) || {
      agentId: k.agentId,
      agent: k.agent,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b.key, { count: 0, amountIdr: 0 }])),
      totalAmountIdr: 0,
      totalCount: 0,
      oldestDays: 0,
    };
    row.buckets[bucket].count += 1;
    row.buckets[bucket].amountIdr += amount;
    row.totalAmountIdr += amount;
    row.totalCount += 1;
    if (ageDays > row.oldestDays) row.oldestDays = ageDays;
    byAgent.set(k.agentId, row);
  }

  // Sort by oldestDays desc so the worst-aged agent lands on top — that's
  // who the admin needs to call first, regardless of Rupiah amount.
  const rows = [...byAgent.values()].sort((a, b) => {
    if (b.oldestDays !== a.oldestDays) return b.oldestDays - a.oldestDays;
    return b.totalAmountIdr - a.totalAmountIdr;
  });

  const grandTotalIdr = rows.reduce((a, r) => a + r.totalAmountIdr, 0);
  const grandTotalCount = rows.reduce((a, r) => a + r.totalCount, 0);

  return {
    buckets: BUCKETS,
    totals,
    rows,
    grandTotal: {
      amountIdr: grandTotalIdr,
      count: grandTotalCount,
      agents: rows.length,
    },
  };
}
