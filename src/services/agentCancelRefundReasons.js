// Stage 304 + S305 — per-agent cancel + refund reason rollup.
//
// Mirrors the S175 (cancel) and S236 (refund) admin panels, but scoped
// to ONE agent's own bookings so the agen sees the reason mix that
// kills their own pipeline. Same code labels + __UNSET__ sentinel
// convention as the admin services so the visual style stays consistent.
//
// Read-only; never writes. Returns empty rows + zero totals when the
// agent had no cancels/refunds in window — caller hides the panel.

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const DEFAULT_DAYS = 90;

const CANCEL_LABELS = {
  JEMAAH_REQUEST: 'Permintaan jemaah',
  PAKET_CANCELLED: 'Paket dibatalkan',
  PAYMENT_NOT_RECEIVED: 'Pembayaran tidak masuk',
  DOCUMENT_INCOMPLETE: 'Dokumen tidak lengkap',
  NO_SHOW: 'Tidak hadir keberangkatan',
  GOODWILL: 'Goodwill operator',
  OTHER: 'Lainnya',
  __UNSET__: 'Belum dikategorikan',
};

const REFUND_LABELS = {
  JEMAAH_REQUEST: 'Permintaan jemaah',
  PAKET_CANCELLED: 'Paket dibatalkan',
  VISA_REJECTED: 'Visa ditolak',
  JEMAAH_ILL: 'Jemaah sakit',
  DOCUMENT_INCOMPLETE: 'Dokumen tidak lengkap',
  NO_SHOW_REFUND: 'Refund no-show',
  GOODWILL: 'Goodwill operator',
  DUPLICATE_PAYMENT: 'Pembayaran ganda',
  FRAUD_CHARGEBACK: 'Chargeback / fraud',
  OTHER: 'Lainnya',
  __UNSET__: 'Belum dikategorikan',
};

/**
 * Returns { cancel: {total, totalPaidIdr, rows[]}, refund: {total, totalIdr, rows[]} }
 * — both lenses for an agent over a trailing window. Empty agents return
 * a zero-shape envelope so the view doesn't crash on null access.
 */
export async function getAgentCancelRefundReasons({
  agentId, days = DEFAULT_DAYS, now = new Date(),
} = {}) {
  if (!agentId) {
    return {
      days,
      cancel: { total: 0, totalPaidIdr: 0, rows: [] },
      refund: { total: 0, totalIdr: 0, rows: [] },
    };
  }
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);

  // Cancel rollup — bookings of this agent that landed in CANCELLED/REFUNDED
  // state within the window. Mirrors S175 grouping.
  const cancelledBookings = await db.booking.findMany({
    where: {
      agentId,
      status: { in: ['CANCELLED', 'REFUNDED'] },
      cancelledAt: { not: null, gte: since },
    },
    select: { id: true, cancelReasonCode: true, paidAmount: true },
  });

  const cancelByCode = new Map();
  let cancelGrandCount = 0;
  let cancelGrandPaid = 0;
  for (const b of cancelledBookings) {
    const code = b.cancelReasonCode || '__UNSET__';
    let row = cancelByCode.get(code);
    if (!row) {
      row = { code, label: CANCEL_LABELS[code] || code, count: 0, paidIdr: 0 };
      cancelByCode.set(code, row);
    }
    row.count += 1;
    cancelGrandCount += 1;
    const paid = toNumber(b.paidAmount) ?? 0;
    row.paidIdr += paid;
    cancelGrandPaid += paid;
  }

  const cancelRows = [...cancelByCode.values()]
    .map((r) => ({
      ...r,
      sharePct: cancelGrandCount > 0
        ? Math.round((r.count / cancelGrandCount) * 1000) / 10
        : null,
    }))
    .sort((a, b) => {
      if (a.code === '__UNSET__') return 1;
      if (b.code === '__UNSET__') return -1;
      return b.count - a.count;
    });

  // Refund rollup — Payment rows with status=REFUNDED whose booking is
  // owned by this agent. Mirrors S236 per-reason grouping but scoped per
  // agent via booking.agentId. IDR-only filter matches the rest of the
  // analytics (mixing currencies would muddle the totals).
  const refundPayments = await db.payment.findMany({
    where: {
      status: 'REFUNDED',
      currency: 'IDR',
      createdAt: { gte: since },
      booking: { agentId },
    },
    select: { amount: true, refundReasonCode: true },
  });

  const refundByCode = new Map();
  let refundGrandCount = 0;
  let refundGrandIdr = 0;
  for (const p of refundPayments) {
    const code = p.refundReasonCode || '__UNSET__';
    const amt = Math.abs(toNumber(p.amount) ?? 0); // stored negative
    let row = refundByCode.get(code);
    if (!row) {
      row = { code, label: REFUND_LABELS[code] || code, count: 0, refundedIdr: 0 };
      refundByCode.set(code, row);
    }
    row.count += 1;
    row.refundedIdr += amt;
    refundGrandCount += 1;
    refundGrandIdr += amt;
  }

  const refundRows = [...refundByCode.values()]
    .map((r) => ({
      ...r,
      sharePct: refundGrandIdr > 0
        ? Math.round((r.refundedIdr / refundGrandIdr) * 1000) / 10
        : null,
    }))
    .sort((a, b) => {
      if (a.code === '__UNSET__') return 1;
      if (b.code === '__UNSET__') return -1;
      return b.refundedIdr - a.refundedIdr;
    });

  return {
    days,
    cancel: { total: cancelGrandCount, totalPaidIdr: cancelGrandPaid, rows: cancelRows },
    refund: { total: refundGrandCount, totalIdr: refundGrandIdr, rows: refundRows },
  };
}

export { CANCEL_LABELS, REFUND_LABELS, DEFAULT_DAYS };
