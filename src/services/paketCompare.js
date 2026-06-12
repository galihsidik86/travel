// Stage 250 — side-by-side comparison of 2-4 paket. Pulls the same
// metrics as the leaderboard (S22/S34/S39/S40/S61) but laid out as
// a column-per-paket sheet so admin can read across e.g. revenue,
// cost, margin, conversion, velocity, ads ROI in one glance.
//
// Slug list normalised + deduped + capped at 4 (more = too narrow
// columns on a typical laptop screen). Unknown slugs silently dropped
// — admin who bookmarks with a renamed/deleted slug still sees the
// rest of the comparison.
//
// Each row in the output is one metric; each column is a paket's
// value. The view renders as <table> with metric labels on the left.

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const MAX_SLUGS = 4;
const ONE_DAY_MS = 86_400_000;

function pct(n, total) {
  if (!total || total === 0) return null;
  return Math.round((n / total) * 1000) / 10;
}

export async function getPaketComparison({ slugs = [], now = new Date() } = {}) {
  // Normalise input
  const cleanSlugs = [...new Set(
    slugs.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean),
  )].slice(0, MAX_SLUGS);

  if (cleanSlugs.length === 0) return { paket: [], cells: [] };

  const paketRows = await db.paket.findMany({
    where: { slug: { in: cleanSlugs }, deletedAt: null },
    select: {
      id: true, slug: true, title: true, status: true,
      departureDate: true, durationDays: true,
      kursiTotal: true, kursiTerisi: true,
      costPerPaxIdr: true, adsSpendIdr: true, komisiRate: true,
    },
  });
  if (paketRows.length === 0) return { paket: [], cells: [] };

  // Preserve admin's input order
  const orderMap = new Map(cleanSlugs.map((s, i) => [s, i]));
  paketRows.sort((a, b) => (orderMap.get(a.slug) ?? 99) - (orderMap.get(b.slug) ?? 99));

  // Bookings + payments + paket-view counts in parallel per paket
  const stats = await Promise.all(paketRows.map(async (p) => {
    const [bookings, payments, viewCount, bookingCount] = await Promise.all([
      db.booking.findMany({
        where: { paketId: p.id },
        select: { id: true, status: true, paxCount: true, totalAmount: true, paidAmount: true },
      }),
      // PAID rows for this paket = lifetime cash received
      db.payment.findMany({
        where: { booking: { paketId: p.id }, status: 'PAID', currency: 'IDR' },
        select: { amount: true },
      }),
      // PaketView count for conversion math
      db.paketView.count({ where: { paketId: p.id } }),
      db.booking.count({
        where: { paketId: p.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      }),
    ]);

    const lunas = bookings.filter((b) => b.status === 'LUNAS');
    const lunasPax = lunas.reduce((acc, b) => acc + (b.paxCount || 1), 0);
    const lunasRevenue = lunas.reduce((acc, b) => acc + (toNumber(b.totalAmount) ?? 0), 0);
    const totalPaid = payments.reduce((acc, p) => acc + (toNumber(p.amount) ?? 0), 0);
    const activeBookings = bookings.filter((b) => !['CANCELLED', 'REFUNDED'].includes(b.status));
    const totalDueIdr = activeBookings.reduce((acc, b) => acc + Math.max(0, (toNumber(b.totalAmount) ?? 0) - (toNumber(b.paidAmount) ?? 0)), 0);

    const cost = toNumber(p.costPerPaxIdr);
    const ads = toNumber(p.adsSpendIdr);
    const komRate = toNumber(p.komisiRate);

    const totalCostIdr = cost != null ? lunasPax * cost : null;
    const komisiLiability = lunasRevenue * (komRate ?? 0.06); // EARNED+PAID per S22 conservative estimate
    const netMargin = totalCostIdr != null ? lunasRevenue - totalCostIdr - komisiLiability : null;
    const marginPct = (netMargin != null && lunasRevenue > 0)
      ? Math.round((netMargin / lunasRevenue) * 1000) / 10
      : null;

    const fillPct = p.kursiTotal > 0
      ? Math.round((p.kursiTerisi / p.kursiTotal) * 1000) / 10
      : null;
    const conversionPct = viewCount > 0 ? pct(bookingCount, viewCount) : null;
    const roiX = ads != null && ads > 0 ? Math.round((lunasRevenue / ads) * 10) / 10 : null;
    const daysToDeparture = p.departureDate
      ? Math.ceil((new Date(p.departureDate).getTime() - now.getTime()) / ONE_DAY_MS)
      : null;

    return {
      slug: p.slug,
      title: p.title,
      status: p.status,
      departureDate: p.departureDate,
      durationDays: p.durationDays,
      daysToDeparture,
      kursiTerisi: p.kursiTerisi,
      kursiTotal: p.kursiTotal,
      fillPct,
      bookingCount: bookings.length,
      activeBookings: activeBookings.length,
      lunasCount: lunas.length,
      lunasPax,
      lunasRevenue,
      totalPaid,
      totalDueIdr,
      costPerPaxIdr: cost,
      totalCostIdr,
      adsSpendIdr: ads,
      roiX,
      komisiRate: komRate,
      komisiLiability,
      netMargin,
      marginPct,
      viewCount,
      conversionPct,
    };
  }));

  // Stable list of metric rows for the comparison sheet. Render order
  // matches what admin scans top-to-bottom: identity → status → revenue
  // → cost → margin → ops.
  const metricRows = [
    { key: 'status', label: 'Status', kind: 'text' },
    { key: 'departureDate', label: 'Departure', kind: 'date' },
    { key: 'daysToDeparture', label: 'Days to dep', kind: 'days' },
    { key: 'durationDays', label: 'Durasi (hari)', kind: 'int' },
    { key: 'fillPct', label: 'Fill %', kind: 'pct' },
    { key: 'kursiTerisi', label: 'Kursi terisi', kind: 'kursi' },
    { key: 'bookingCount', label: 'Total booking', kind: 'int' },
    { key: 'lunasCount', label: 'LUNAS booking', kind: 'int' },
    { key: 'lunasPax', label: 'LUNAS pax', kind: 'int' },
    { key: 'lunasRevenue', label: 'Revenue LUNAS', kind: 'idr' },
    { key: 'totalPaid', label: 'Cash diterima', kind: 'idr' },
    { key: 'totalDueIdr', label: 'Sisa tagihan', kind: 'idr' },
    { key: 'costPerPaxIdr', label: 'Biaya per pax', kind: 'idr_or_null' },
    { key: 'totalCostIdr', label: 'Total biaya vendor', kind: 'idr_or_null' },
    { key: 'adsSpendIdr', label: 'Ads spend', kind: 'idr_or_null' },
    { key: 'roiX', label: 'Ads ROI (x)', kind: 'roi' },
    { key: 'komisiRate', label: 'Komisi default (%)', kind: 'rate_pct' },
    { key: 'komisiLiability', label: 'Komisi terikat (est.)', kind: 'idr' },
    { key: 'netMargin', label: 'Net margin', kind: 'idr_or_null' },
    { key: 'marginPct', label: 'Margin %', kind: 'margin_pct' },
    { key: 'viewCount', label: 'Visits (lifetime)', kind: 'int' },
    { key: 'conversionPct', label: 'Conv %', kind: 'conv_pct' },
  ];

  return {
    paket: stats,
    metricRows,
    inputSlugs: cleanSlugs,
    missingSlugs: cleanSlugs.filter((s) => !stats.some((p) => p.slug === s)),
  };
}

export { MAX_SLUGS };
