// Stage 79 — per-notif-type CTR over a rolling window.
//
// CTR = unique-click rate, computed as:
//   - sent      = count(Notification where status=SENT in window, channel=EMAIL)
//   - clicked   = count(Notification with at least one EmailClick row)
//   - ctrPct    = clicked / sent × 100
//
// Why unique-click and not raw click volume:
//   - One recipient clicking the link 5 times shouldn't read as "500% CTR"
//   - Marketing teams think in terms of "did the recipient engage" not
//     "how many tabs did they open"
//
// Excluded:
//   - Non-EMAIL channels (WA doesn't go through /r/<token>)
//   - SKIPPED / PENDING / FAILED rows (denominator = SENT only)
//   - Types with <5 SENT in window (sample too small to declare CTR;
//     marked `lowSample: true` so view can dim them)

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getEmailCtrByType({ now = new Date(), days = 30 } = {}) {
  const start = new Date(now.getTime() - days * ONE_DAY_MS);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS);

  // SENT counts per type. groupBy is fastest here.
  const sentRows = await db.notification.groupBy({
    by: ['type'],
    where: {
      channel: 'EMAIL',
      status: 'SENT',
      sentAt: { gte: start, lt: end },
    },
    _count: { _all: true },
  });
  if (sentRows.length === 0) {
    return { rows: [], windowDays: days, totals: { sent: 0, clicked: 0, ctrPct: null } };
  }
  const sentByType = new Map(sentRows.map((r) => [r.type, r._count._all]));

  // Clicked counts per type — needs a join through EmailClick → Notification.
  // Use a raw groupBy via notification with `clicks: { some: {} }` predicate.
  const clickedRows = await db.notification.groupBy({
    by: ['type'],
    where: {
      channel: 'EMAIL',
      status: 'SENT',
      sentAt: { gte: start, lt: end },
      clicks: { some: {} },
    },
    _count: { _all: true },
  });
  const clickedByType = new Map(clickedRows.map((r) => [r.type, r._count._all]));

  const rows = [...sentByType.entries()]
    .map(([type, sent]) => {
      const clicked = clickedByType.get(type) || 0;
      const ctrPct = sent > 0 ? Math.round((clicked / sent) * 1000) / 10 : null;
      return {
        type,
        sent,
        clicked,
        ctrPct,
        lowSample: sent < 5,
      };
    })
    // Default sort: highest sample first so admin sees the most reliable
    // numbers at the top. Tie-break by type name for stability.
    .sort((a, b) => b.sent - a.sent || a.type.localeCompare(b.type));

  const totalSent = rows.reduce((s, r) => s + r.sent, 0);
  const totalClicked = rows.reduce((s, r) => s + r.clicked, 0);
  const overallCtr = totalSent > 0
    ? Math.round((totalClicked / totalSent) * 1000) / 10
    : null;

  return {
    rows,
    windowDays: days,
    totals: { sent: totalSent, clicked: totalClicked, ctrPct: overallCtr },
  };
}
