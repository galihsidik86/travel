// Stage 263 — per-group needs-attention rollup for /admin overview.
//
// Surfaces groups where ≥1 member has an operational gap: unpaid
// balance, no pickup choice (on a paket with pickups configured),
// or required docs missing (passport + visa umroh + meningitis vax).
//
// We DON'T sum across the whole group — instead each gap is reported
// as a per-member count so admin sees "Keluarga Pak Ahmad: 2 jemaah
// pickup belum dipilih · 3 jemaah balance Rp 12jt" at a glance.
//
// Sort: groups with the most outstanding gaps first. Hidden when
// nothing surfaces (no waste of real-estate on a clean week).

import { db } from '../lib/db.js';

const REQUIRED_DOC_TYPES = ['VISA_UMROH', 'VACCINE_MENINGITIS'];

/**
 * @param {object} opts
 * @param {number} [opts.limit=10] cap rows so the panel stays scannable
 * @returns {Promise<{rows: Array, total: number}>}
 */
export async function getGroupsNeedsAttention({ limit = 10 } = {}) {
  // Pull only active bookings carrying a groupKey. Single query keeps
  // this cheap; per-group rollup happens in JS.
  const bookings = await db.booking.findMany({
    where: {
      groupKey: { not: null },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: {
      id: true, bookingNo: true, status: true, paxCount: true,
      totalAmount: true, paidAmount: true,
      groupKey: true,
      pickupId: true,
      paket: { select: { id: true, slug: true, title: true } },
      jemaah: {
        select: {
          id: true, fullName: true, passportNo: true,
          documents: {
            where: { type: { in: REQUIRED_DOC_TYPES } },
            select: { type: true, status: true },
          },
        },
      },
    },
  });

  if (bookings.length === 0) return { rows: [], total: 0 };

  // Find which paket have pickups configured at all. Pickup-not-chosen
  // is only a gap when the paket OFFERS pickup; ignoring it elsewhere
  // saves a misleading "missing pickup" red flag on paket with no
  // pickup setup yet.
  const paketIds = [...new Set(bookings.map((b) => b.paket?.id).filter(Boolean))];
  const paketsWithPickup = await db.paketPickup.findMany({
    where: { paketId: { in: paketIds } },
    select: { paketId: true },
    distinct: ['paketId'],
  });
  const pickupPaketIds = new Set(paketsWithPickup.map((p) => p.paketId));

  // Group lookup for labels — best-effort (groups without metadata
  // are fine, the panel just won't show a nickname).
  const groupKeys = [...new Set(bookings.map((b) => b.groupKey).filter(Boolean))];
  const meta = await db.bookingGroup.findMany({
    where: { groupKey: { in: groupKeys } },
    select: { groupKey: true, label: true },
  });
  const labelByKey = Object.fromEntries(meta.map((m) => [m.groupKey, m.label]));

  // Per-group rollup.
  const rollup = new Map();
  for (const b of bookings) {
    const key = b.groupKey;
    if (!rollup.has(key)) {
      rollup.set(key, {
        groupKey: key,
        label: labelByKey[key] || null,
        memberCount: 0,
        unpaidCount: 0,
        unpaidBalanceIdr: 0,
        missingPickupCount: 0,
        missingDocCount: 0,
        offersPickup: false,
        paket: b.paket || null, // most groups land on one paket; capture first for deep link
        gapTotal: 0,
      });
    }
    const row = rollup.get(key);
    row.memberCount += 1;

    const total = Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
    const paid = Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0;
    const balance = total - paid;
    if (balance > 0) {
      row.unpaidCount += 1;
      row.unpaidBalanceIdr += balance;
    }

    const paketOffersPickup = b.paket && pickupPaketIds.has(b.paket.id);
    if (paketOffersPickup) {
      row.offersPickup = true;
      if (!b.pickupId) row.missingPickupCount += 1;
    }

    // Required docs gap: any required type not VERIFIED counts as missing.
    // Also count missing passport (jemaah.passportNo absent) as a doc gap —
    // it's the most basic credential.
    const docsByType = Object.fromEntries(
      (b.jemaah?.documents || []).map((d) => [d.type, d.status]),
    );
    const docsMissing = REQUIRED_DOC_TYPES.filter((t) => docsByType[t] !== 'VERIFIED').length;
    const passportMissing = !b.jemaah?.passportNo ? 1 : 0;
    if (docsMissing + passportMissing > 0) row.missingDocCount += 1;
  }

  // Compute gapTotal (used for sort) + drop zero-gap rows.
  const rows = [];
  for (const row of rollup.values()) {
    row.gapTotal = row.unpaidCount + row.missingPickupCount + row.missingDocCount;
    if (row.gapTotal > 0) rows.push(row);
  }
  rows.sort((a, b) => b.gapTotal - a.gapTotal);

  return { rows: rows.slice(0, limit), total: rows.length };
}
