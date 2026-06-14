// Per-booking printable voucher (stage 20). Pairs with the print
// manifest (stage 19): manifest is the admin's worksheet of every
// jemaah on a paket; the voucher is the per-jemaah summary the admin
// hands out at manasik (or the jemaah prints from their portal).
//
// Two ownership-checked entry points:
//   - getJemaahBookingVoucher(userId, bookingId) — /saya path; refuses
//     if the booking isn't claimed by `userId`
//   - getAdminBookingVoucher(bookingId) — /admin path; no ownership
//     check (admin RBAC handled at the route layer)
//
// Both return the same shape so the view doesn't branch.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const VOUCHER_INCLUDE = {
  paket: {
    select: {
      id: true, slug: true, title: true, subtitle: true,
      departureDate: true, returnDate: true, durationDays: true,
      airline: true, airlineCode: true, routeFrom: true, routeTo: true,
      hotels: {
        select: { city: true, name: true, stars: true, nights: true, order: true },
        orderBy: [{ order: 'asc' }, { city: 'asc' }],
      },
      days: {
        select: {
          dayNumber: true, dayRange: true, dateLabel: true, monthLabel: true,
          title: true, highlight: true,
        },
        orderBy: { dayNumber: 'asc' },
      },
    },
  },
  jemaah: {
    select: {
      fullName: true, phone: true, email: true,
      nik: true, gender: true, birthDate: true,
      passportNo: true, passportExpiry: true,
      emergencyContact: true,
    },
  },
  agent: { select: { slug: true, displayName: true, whatsapp: true } },
  room: { select: { roomNo: true, floor: true, wing: true } },
  payments: {
    where: { status: { in: ['PAID', 'REFUNDED'] } },
    orderBy: { createdAt: 'asc' },
    select: { amount: true, currency: true, method: true, paidAt: true, createdAt: true, notes: true, status: true },
  },
  // Stage 287 — voucher PDF includes attached add-ons section so jemaah
  // sees exactly what they've been charged for (and admin can hand the
  // voucher to vendors as proof of extras).
  addons: {
    orderBy: { createdAt: 'asc' },
    select: { nameSnapshot: true, priceIdrSnapshot: true, quantity: true },
  },
};

function shape(booking) {
  // Build a compact "payment schedule" snapshot — the past payments + a
  // computed "sisa" so the jemaah sees what's left before departure.
  const totalAmount = Number(booking.totalAmount?.toString?.() ?? booking.totalAmount) || 0;
  const paidAmount = Number(booking.paidAmount?.toString?.() ?? booking.paidAmount) || 0;
  const remaining = Math.max(0, totalAmount - paidAmount);
  const pct = totalAmount > 0 ? Math.round((paidAmount / totalAmount) * 100) : 0;
  // Stage 287 — normalise add-on rows so the renderer doesn't have to
  // peek into Decimal types. addonSubtotal sums all attached add-ons
  // for the payment-summary footer in the PDF.
  const addons = Array.isArray(booking.addons) ? booking.addons.map((a) => {
    const price = Number(a.priceIdrSnapshot?.toString?.() ?? a.priceIdrSnapshot) || 0;
    return {
      name: a.nameSnapshot,
      priceIdr: price,
      quantity: a.quantity,
      lineTotalIdr: price * a.quantity,
    };
  }) : [];
  const addonSubtotal = addons.reduce((acc, a) => acc + a.lineTotalIdr, 0);
  return {
    ...booking,
    addons,
    totals: { totalAmount, paidAmount, remaining, paidPct: pct, addonSubtotal },
    generatedAt: new Date(),
  };
}

export async function getJemaahBookingVoucher(userId, bookingId) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: VOUCHER_INCLUDE,
  });
  // 404 (not 403) on cross-user access so we don't leak existence.
  if (!booking || booking.jemaahUserId !== userId) {
    throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  }
  return shape(booking);
}

export async function getAdminBookingVoucher(bookingId) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: VOUCHER_INCLUDE,
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  return shape(booking);
}
