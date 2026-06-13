// Stage 268 — per-booking installment schedule.
//
// Schema (Json on Booking.installmentSchedule):
//   [
//     { id: 'inst-1', dueDate: '2026-06-01', amountIdr: 5000000,
//       status: 'PENDING'|'PAID', paidAt?: '2026-05-30T...' },
//     ...
//   ]
//
// Sum of amountIdr SHOULD equal Booking.totalAmount but we don't
// enforce that — admin may set deposit-first plans where the last
// installment is "TBD" math. We DO emit a warning when the sum is
// off so admin sees the diff.
//
// Stage 269 will auto-mark installments PAID via reconcileFromPayment
// when payments land via recordPayment.

import { randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const INSTALLMENT_STATUSES = ['PENDING', 'PAID'];

function shortId() {
  return randomBytes(4).toString('hex');
}

/**
 * Normalise + validate one installment entry. Returns the cleaned shape
 * or throws HttpError(400) on bad input.
 */
function cleanEntry(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    throw new HttpError(400, `Installment #${idx + 1}: format invalid`, 'INSTALLMENT_INVALID');
  }
  const id = String(raw.id || shortId()).trim().slice(0, 20);
  const dueDate = String(raw.dueDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new HttpError(400, `Installment #${idx + 1}: dueDate harus YYYY-MM-DD`, 'INSTALLMENT_BAD_DATE');
  }
  const amountRaw = Number(raw.amountIdr);
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    throw new HttpError(400, `Installment #${idx + 1}: amountIdr harus > 0`, 'INSTALLMENT_BAD_AMOUNT');
  }
  const amountIdr = Math.round(amountRaw);
  const status = String(raw.status || 'PENDING').toUpperCase();
  if (!INSTALLMENT_STATUSES.includes(status)) {
    throw new HttpError(400, `Installment #${idx + 1}: status invalid`, 'INSTALLMENT_BAD_STATUS');
  }
  const entry = { id, dueDate, amountIdr, status };
  if (status === 'PAID') {
    // Preserve admin-supplied paidAt or stamp now.
    const paidAt = raw.paidAt ? new Date(raw.paidAt).toISOString() : new Date().toISOString();
    entry.paidAt = paidAt;
  }
  return entry;
}

/**
 * Normalise + validate the full schedule. Throws on bad input.
 * Empty array OR null clears the schedule (idempotent).
 */
export function normaliseSchedule(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Schedule harus berupa array', 'INSTALLMENT_NOT_ARRAY');
  }
  if (raw.length === 0) return null;
  if (raw.length > 24) {
    throw new HttpError(400, 'Maksimal 24 installment per booking', 'INSTALLMENT_TOO_MANY');
  }
  const cleaned = raw.map(cleanEntry);
  // Sort by dueDate asc so the order is canonical regardless of admin's
  // input order — keeps auto-reconcile deterministic.
  cleaned.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  // Re-stamp deduplicated ids so repeat saves with same dueDate don't
  // collide. Admin-supplied ids preserved when unique within the batch.
  const seen = new Set();
  for (const c of cleaned) {
    while (seen.has(c.id)) c.id = shortId();
    seen.add(c.id);
  }
  return cleaned;
}

/**
 * Compute summary numbers for view-side rendering.
 * Returns null when schedule is null/empty.
 */
export function summariseSchedule(schedule, { now = new Date() } = {}) {
  if (!schedule || schedule.length === 0) return null;
  let pendingCount = 0;
  let paidCount = 0;
  let totalIdr = 0;
  let paidIdr = 0;
  let pendingIdr = 0;
  let nextDue = null;
  let nextDueAmount = 0;
  let overdueCount = 0;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  for (const i of schedule) {
    totalIdr += i.amountIdr;
    if (i.status === 'PAID') {
      paidCount += 1;
      paidIdr += i.amountIdr;
    } else {
      pendingCount += 1;
      pendingIdr += i.amountIdr;
      if (nextDue == null) {
        nextDue = i.dueDate;
        nextDueAmount = i.amountIdr;
      }
      // Compare via YYYY-MM-DD string vs local YYYY-MM-DD — works
      // because both are zero-padded ISO dates.
      const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (i.dueDate < todayYmd) overdueCount += 1;
    }
  }
  return {
    count: schedule.length,
    pendingCount, paidCount,
    totalIdr, paidIdr, pendingIdr,
    nextDue, nextDueAmount,
    overdueCount,
  };
}

/**
 * Set the installment schedule on a booking. Idempotent
 * (skip-audit-on-no-op).
 *
 * Refuses on CANCELLED/REFUNDED (frozen state shouldn't accept
 * schedule changes).
 */
export async function setBookingInstallmentSchedule({ req, actor, bookingId, schedule }) {
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, installmentSchedule: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — schedule beku', 'BOOKING_CLOSED');
  }

  const next = normaliseSchedule(schedule);
  const prev = Array.isArray(before.installmentSchedule) ? before.installmentSchedule : null;
  // Diff by JSON.stringify — installment arrays are small + flat.
  if (JSON.stringify(prev) === JSON.stringify(next)) {
    return { updated: false, schedule: prev };
  }

  await db.booking.update({
    where: { id: bookingId },
    data: { installmentSchedule: next },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { installmentCount: prev ? prev.length : 0 },
    after: {
      installmentScheduleSet: true,
      installmentCount: next ? next.length : 0,
      totalScheduled: next ? next.reduce((acc, i) => acc + i.amountIdr, 0) : 0,
    },
  });
  return { updated: true, schedule: next };
}

/**
 * Stage 269 — reconcile installments against a freshly-recorded
 * payment. Walks PENDING entries in order; marks PAID when the
 * incoming amount fully covers the entry. Returns the updated
 * schedule (or null when no reconciliation happened) plus a
 * `consumed` count for the audit row.
 *
 * Partial coverage = entry left PENDING (we don't split installments —
 * the agreed schedule is the contract; admin can edit if jemaah pays
 * a partial). Once an entry is PAID it stays PAID.
 *
 * Does NOT write to DB itself — the caller (recordPayment) is the
 * single source of truth for money math. This function returns the
 * new schedule + caller writes it inside the same transaction.
 */
/**
 * Stage 271 — auto-suggest an installment plan. Splits remaining balance
 * (`totalAmount - paidAmount`) into N roughly-equal monthly installments
 * ending one month before `departureDate` (or before `manifestClosesAt`,
 * whichever is earlier).
 *
 * Tail-cents convention: the last installment carries the rounding
 * remainder so the sum exactly matches the remaining balance. (Splitting
 * Rp 10,000,000 over 3 → 3,333,333 × 2 + 3,333,334.)
 *
 * Refusals:
 *   - `remaining <= 0` → BALANCE_ZERO (nothing to schedule)
 *   - `count < 1 OR > 24` → BAD_COUNT (server-side cap matches normaliseSchedule)
 *   - `departureDate <= now` → DEPARTURE_PAST (no room to schedule)
 *   - end-of-schedule cutoff <= now → NO_TIME (jemaah at <30 days; pay now)
 *
 * Does NOT persist — returns the proposed array. Caller decides whether
 * to apply it via `setBookingInstallmentSchedule`. This keeps the UX
 * "review before save" — admin can tweak counts/dates after.
 */
export async function suggestInstallmentPlan({ bookingId, count = 6, now = new Date() }) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, totalAmount: true, paidAmount: true, status: true,
      paket: { select: { departureDate: true, manifestClosesAt: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }
  const total = Number(booking.totalAmount?.toString?.() ?? booking.totalAmount) || 0;
  const paid = Number(booking.paidAmount?.toString?.() ?? booking.paidAmount) || 0;
  const remaining = total - paid;
  if (remaining <= 0) {
    throw new HttpError(409, 'Tidak ada sisa pembayaran untuk dijadwalkan', 'BALANCE_ZERO');
  }
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > 24) {
    throw new HttpError(400, 'Jumlah cicilan harus 1-24', 'BAD_COUNT');
  }

  const departure = booking.paket?.departureDate ? new Date(booking.paket.departureDate) : null;
  const closes = booking.paket?.manifestClosesAt ? new Date(booking.paket.manifestClosesAt) : null;
  if (!departure || departure.getTime() <= now.getTime()) {
    throw new HttpError(409, 'Tanggal keberangkatan sudah lewat / belum diset', 'DEPARTURE_PAST');
  }

  // End cutoff: 1 month before departure OR manifest close, whichever earlier
  const lastDue = new Date(Math.min(
    departure.getTime() - 30 * 24 * 60 * 60_000,
    closes ? closes.getTime() : Infinity,
  ));
  if (lastDue.getTime() <= now.getTime()) {
    throw new HttpError(409, 'Sudah terlalu dekat keberangkatan untuk dijadwalkan', 'NO_TIME');
  }

  // First due ~1 week from now (give jemaah breathing room before first payment).
  // If N=1, just last due. Otherwise spread evenly between firstDue and lastDue.
  const firstDue = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  if (firstDue.getTime() >= lastDue.getTime()) {
    // Window too tight — collapse to single installment on lastDue
    return [{
      id: undefined, // let normaliseSchedule auto-generate
      dueDate: localYmd(lastDue),
      amountIdr: remaining,
      status: 'PENDING',
    }];
  }

  // Split evenly. Each gets floor(remaining/n); last carries the remainder.
  const each = Math.floor(remaining / n);
  const tail = remaining - each * (n - 1);
  const span = lastDue.getTime() - firstDue.getTime();
  const step = n > 1 ? span / (n - 1) : 0;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const due = new Date(firstDue.getTime() + step * i);
    out.push({
      dueDate: localYmd(due),
      amountIdr: i === n - 1 ? tail : each,
      status: 'PENDING',
    });
  }
  return out;
}

function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function applyPaymentToSchedule(schedule, amountIdr, { now = new Date() } = {}) {
  if (!schedule || schedule.length === 0) return { changed: false, schedule };
  if (!amountIdr || amountIdr <= 0) return { changed: false, schedule };
  let remaining = amountIdr;
  let changed = false;
  const updated = schedule.map((entry) => {
    if (entry.status === 'PAID') return entry;
    if (remaining >= entry.amountIdr) {
      remaining -= entry.amountIdr;
      changed = true;
      return { ...entry, status: 'PAID', paidAt: now.toISOString() };
    }
    return entry;
  });
  return { changed, schedule: updated };
}
