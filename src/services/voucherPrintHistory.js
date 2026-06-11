// Stage 198 — stamp the voucher-print counters when a voucher PDF is
// downloaded. Fire-and-forget: a counter-write failure must never
// break the actual PDF download.
//
// Counter pattern: `voucherPrintCount` increments, `lastVoucherPrintedAt`
// stamps `now`, `lastVoucherPrintedByEmail` records the actor (admin
// email when downloaded via /admin route, jemaah email when downloaded
// via /saya route, or null for anonymous bundle paths).

import { db } from '../lib/db.js';

export async function recordVoucherPrint({ bookingId, actorEmail = null }) {
  if (!bookingId) return;
  try {
    await db.booking.update({
      where: { id: bookingId },
      data: {
        voucherPrintCount: { increment: 1 },
        lastVoucherPrintedAt: new Date(),
        lastVoucherPrintedByEmail: actorEmail || null,
      },
    });
  } catch (err) {
    console.warn('[voucher-print] counter bump failed:', err?.message || err);
  }
}
