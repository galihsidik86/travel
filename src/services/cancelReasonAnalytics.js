// Stage 175 — cancel reason breakdown over a window. Powers the
// /admin overview panel "Why are bookings cancelling?".
//
// Includes both CANCELLED + REFUNDED bookings (both represent a
// real cancel event from the operator's perspective). Excludes
// rows where cancelledAt is null (defensive — shouldn't happen
// but a manually-set status could leave it blank).

import { db } from '../lib/db.js';

const DEFAULT_WINDOW_DAYS = 90;

const CODE_LABELS = {
  JEMAAH_REQUEST: 'Permintaan jemaah',
  PAKET_CANCELLED: 'Paket dibatalkan operator',
  PAYMENT_NOT_RECEIVED: 'Pembayaran tidak masuk',
  DOCUMENT_INCOMPLETE: 'Dokumen tidak lengkap',
  NO_SHOW: 'Tidak hadir keberangkatan',
  GOODWILL: 'Goodwill operator',
  OTHER: 'Lainnya',
  __UNSET__: 'Belum dikategorikan',
};

export async function getCancelReasonBreakdown({
  days = DEFAULT_WINDOW_DAYS, now = new Date(),
} = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const rows = await db.booking.findMany({
    where: {
      status: { in: ['CANCELLED', 'REFUNDED'] },
      cancelledAt: { not: null, gte: since },
    },
    select: {
      id: true, cancelReasonCode: true,
      paidAmount: true, totalAmount: true,
    },
  });

  // Group by code. Null codes bucket under __UNSET__ so admin can
  // see the categorisation backlog (older cancels pre-S175 + admins
  // who don't pick a category).
  const grouped = new Map();
  let grandCount = 0;
  let grandPaid = 0;
  for (const r of rows) {
    const code = r.cancelReasonCode || '__UNSET__';
    let row = grouped.get(code);
    if (!row) {
      row = { code, label: CODE_LABELS[code] || code, count: 0, paidIdr: 0 };
      grouped.set(code, row);
    }
    row.count += 1;
    grandCount += 1;
    const paid = Number(r.paidAmount?.toString?.() ?? r.paidAmount) || 0;
    row.paidIdr += paid;
    grandPaid += paid;
  }

  // Compute per-row percentages + sort by count desc. Unset bucket
  // stays at the end regardless of size so the categorised data
  // dominates the visual ranking.
  const breakdown = [...grouped.values()]
    .map((r) => ({
      ...r,
      sharePct: grandCount > 0 ? Math.round((r.count / grandCount) * 1000) / 10 : null,
    }))
    .sort((a, b) => {
      if (a.code === '__UNSET__') return 1;
      if (b.code === '__UNSET__') return -1;
      return b.count - a.count;
    });

  return {
    days, total: grandCount, totalPaidIdr: grandPaid,
    rows: breakdown,
  };
}

export { CODE_LABELS, DEFAULT_WINDOW_DAYS };
