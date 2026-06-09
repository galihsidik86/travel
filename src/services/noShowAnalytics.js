// Stage 146 — no-show rate analytics. Per-paket + per-agent breakdown
// of bookings that ended up flagged via S144 detect-no-shows.
//
// Window scopes the noShowAt stamp (the moment the system flagged the
// row), NOT the booking createdAt or paket departureDate. That's the
// right read for "where are no-shows happening RECENTLY" — older
// no-shows already had their accountability cycle.
//
// Rate = no-shows ÷ resolved-active bookings on the same paket/agent,
// where "resolved-active" = bookings whose paket departureDate has
// passed (i.e. we have a final answer for them: showed-up or no-show).
// We don't include future-departing bookings in the denominator since
// they could still go either way.
//
// Walk-in bookings (no agent) bucket under the `__kp__` sentinel
// mirroring the S35 refund analytics convention.

import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;
const KANTOR_PUSAT_KEY = '__kp__';

function resolveWindow(now, days) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS);  // include today
  const start = new Date(end.getTime() - days * ONE_DAY_MS);
  return { start, end };
}

/**
 * Stage 146 — per-paket + per-agent no-show rollup.
 *
 * @returns {{
 *   window: {days, from, to},
 *   totals: {noShowCount, resolvedActive, ratePct},
 *   byPaket: Array<{paketId, slug, title, noShowCount, resolvedActive, ratePct}>,
 *   byAgent: Array<{agentKey, slug, displayName, noShowCount, resolvedActive, ratePct}>,
 * }}
 *
 * `ratePct` is null when `resolvedActive=0` (no denominator → divide-
 * by-zero would mislead). Rows are sorted by noShowCount desc so the
 * heaviest leakers land at the top.
 */
export async function getNoShowAnalytics({ now = new Date(), days = 90 } = {}) {
  const { start, end } = resolveWindow(now, days);

  // Numerator: bookings stamped no-show within window.
  const noShows = await db.booking.findMany({
    where: {
      noShowAt: { gte: start, lt: end },
    },
    select: {
      id: true,
      paket: { select: { id: true, slug: true, title: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });

  // Denominator: bookings whose paket has already departed AND that
  // haven't been CANCELLED/REFUNDED — those are the trips we have a
  // verdict on. Window scope is the paket's departureDate, NOT
  // booking.createdAt — a no-show stamped this month came from a paket
  // that departed this month (or earlier within window).
  const resolved = await db.booking.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: { departureDate: { gte: start, lt: end } },
    },
    select: {
      id: true,
      paket: { select: { id: true, slug: true, title: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });

  // Roll up
  const paketAgg = new Map();
  const agentAgg = new Map();
  function bumpPaket(b, key) {
    if (!b.paket) return;
    let row = paketAgg.get(b.paket.id);
    if (!row) {
      row = { paketId: b.paket.id, slug: b.paket.slug, title: b.paket.title,
              noShowCount: 0, resolvedActive: 0 };
      paketAgg.set(b.paket.id, row);
    }
    row[key] += 1;
  }
  function bumpAgent(b, key) {
    const agentKey = b.agent?.slug || KANTOR_PUSAT_KEY;
    let row = agentAgg.get(agentKey);
    if (!row) {
      row = {
        agentKey,
        slug: b.agent?.slug || null,
        displayName: b.agent?.displayName || 'Kantor Pusat',
        noShowCount: 0, resolvedActive: 0,
      };
      agentAgg.set(agentKey, row);
    }
    row[key] += 1;
  }
  for (const b of resolved) {
    bumpPaket(b, 'resolvedActive');
    bumpAgent(b, 'resolvedActive');
  }
  for (const b of noShows) {
    bumpPaket(b, 'noShowCount');
    bumpAgent(b, 'noShowCount');
  }

  function finalize(rows) {
    return [...rows.values()]
      .map((r) => ({
        ...r,
        // Null when no denominator — surfaces as "—" in the view, not "0%"
        ratePct: r.resolvedActive === 0
          ? null
          : Math.round((r.noShowCount / r.resolvedActive) * 1000) / 10,
      }))
      .filter((r) => r.noShowCount > 0 || r.resolvedActive > 0)
      .sort((a, b) => {
        if (b.noShowCount !== a.noShowCount) return b.noShowCount - a.noShowCount;
        return b.resolvedActive - a.resolvedActive;
      });
  }

  const totalNoShow = noShows.length;
  const totalResolved = resolved.length;

  return {
    window: { days, from: start, to: end },
    totals: {
      noShowCount: totalNoShow,
      resolvedActive: totalResolved,
      ratePct: totalResolved === 0
        ? null
        : Math.round((totalNoShow / totalResolved) * 1000) / 10,
    },
    byPaket: finalize(paketAgg),
    byAgent: finalize(agentAgg),
  };
}
