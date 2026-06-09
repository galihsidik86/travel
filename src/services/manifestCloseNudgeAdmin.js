// Stage 142 — admin mirror of the S141 jemaah-side nudge.
//
// Surfaces "what nudges have been sent in the last N hours, grouped by
// paket" so admin can do manual WA follow-up without grep'ing the notif
// queue. Default 24h window matches the daily cron cadence.
//
// Grouping is per-paket (not per-booking) — the actionable signal is
// "Ramadhan-2026 still has 3 jemaah with stuck docs", not a flat list.
// Each row carries paket identity + the bookings that got nudged + the
// missing-items rollup.

import { db } from '../lib/db.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Recent MANIFEST_CLOSE_NUDGE notifs grouped by paket. Returns:
 *   { rows: [{ paket, bookings, totalJemaah, hoursSinceLast, missingSummary }],
 *     windowHours, totalPaket, totalBookings }
 *
 * `bookings` is deduplicated by bookingId — multiple channels (EMAIL +
 * WA) for the same booking collapse into one entry, with `channels:
 * ['EMAIL','WA']` so admin sees which channels actually went out.
 *
 * `missingSummary` aggregates `{label: count}` across all the bookings
 * for that paket. Lets the admin scan "8 jemaah missing visa umroh,
 * 3 missing emergency contact" without expanding every row.
 */
export async function getManifestCloseNudgeAdminSummary({
  windowHours = 24, now = new Date(),
} = {}) {
  const since = new Date(now.getTime() - windowHours * ONE_HOUR_MS);

  // Notif rows in window. We filter by relatedEntity to keep the
  // query cheap regardless of how big the queue is.
  const notifs = await db.notification.findMany({
    where: {
      type: 'MANIFEST_CLOSE_NUDGE',
      relatedEntity: 'Booking',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, channel: true, status: true,
      relatedEntityId: true, payload: true,
      createdAt: true,
    },
  });
  if (notifs.length === 0) {
    return { rows: [], windowHours, totalPaket: 0, totalBookings: 0 };
  }

  // Resolve the bookings → paket join. Batch lookup so we don't N+1.
  const bookingIds = [...new Set(notifs.map((n) => n.relatedEntityId).filter(Boolean))];
  const bookings = await db.booking.findMany({
    where: { id: { in: bookingIds } },
    select: {
      id: true, bookingNo: true, status: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: {
        select: {
          id: true, slug: true, title: true,
          manifestClosesAt: true, departureDate: true,
        },
      },
    },
  });
  const byBooking = new Map(bookings.map((b) => [b.id, b]));

  // Group: paketId → { paket, bookings: Map<bookingId, {...}> }
  const paketGroups = new Map();
  for (const n of notifs) {
    const b = byBooking.get(n.relatedEntityId);
    if (!b || !b.paket) continue;  // orphaned notif (booking deleted) — skip
    const paketId = b.paket.id;
    let group = paketGroups.get(paketId);
    if (!group) {
      group = {
        paket: b.paket,
        bookings: new Map(),
        latestNotifAt: n.createdAt,
        missingTally: new Map(),
      };
      paketGroups.set(paketId, group);
    }
    let row = group.bookings.get(b.id);
    if (!row) {
      // Snapshot missing items from payload (S141 stored them in vars)
      const missing = Array.isArray(n.payload?.missing) ? n.payload.missing : [];
      for (const m of missing) {
        group.missingTally.set(m, (group.missingTally.get(m) || 0) + 1);
      }
      row = {
        bookingId: b.id, bookingNo: b.bookingNo,
        bookingStatus: b.status,
        jemaah: b.jemaah,
        channels: new Set(),
        missing,
        notifiedAt: n.createdAt,
      };
      group.bookings.set(b.id, row);
    }
    row.channels.add(n.channel);
    // Keep the latest notif timestamp per group
    if (n.createdAt > group.latestNotifAt) group.latestNotifAt = n.createdAt;
  }

  // Materialise + sort
  const rows = [];
  for (const group of paketGroups.values()) {
    const bks = [...group.bookings.values()].map((r) => ({
      ...r,
      channels: [...r.channels].sort(),
    }));
    const missingSummary = [...group.missingTally.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    rows.push({
      paket: group.paket,
      bookings: bks,
      totalJemaah: bks.length,
      hoursSinceLast: Math.round((now.getTime() - group.latestNotifAt.getTime()) / ONE_HOUR_MS),
      latestNotifAt: group.latestNotifAt,
      missingSummary,
    });
  }
  // Sort by manifestClosesAt asc (most-urgent first); fall back to
  // latestNotifAt desc when close date is null (shouldn't happen post-S141
  // but defensive).
  rows.sort((a, b) => {
    const aClose = a.paket.manifestClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bClose = b.paket.manifestClosesAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aClose !== bClose) return aClose - bClose;
    return b.latestNotifAt.getTime() - a.latestNotifAt.getTime();
  });

  const totalBookings = rows.reduce((sum, r) => sum + r.bookings.length, 0);
  return { rows, windowHours, totalPaket: rows.length, totalBookings };
}
