// Stage 288 — jemaah requests an add-on from /saya/bookings/:id.
//
// Lightweight ask flow: jemaah picks from the active catalog → service
// emails ACTIVE OWNER+SUPERADMIN+MANAJER_OPS the request → admin
// reviews + manually attaches via S284 (since attach mutates totalAmount
// + the price must be confirmed with jemaah). No DB model — the request
// IS the notification; admin acts on it from the notif queue or directly
// on the booking-detail page after seeing the notif.
//
// Per-(booking, addon, jemaah) 6h cooldown to prevent accidental
// double-submit. Cooldown check uses Notification.relatedEntityId =
// booking.id + payload kind/addonId match.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
const COOLDOWN_HOURS = 6;

/**
 * Jemaah picks an add-on from the catalog. Validation:
 *   - quantity ∈ [1, 50]
 *   - addon must belong to the booking's paket
 *   - addon must be active
 *   - booking must be open (not CANCELLED/REFUNDED)
 *   - jemaah must own the booking (via jemaahUserId)
 *
 * Effect: enqueues a GENERIC EMAIL per ACTIVE admin with the request
 * details; admin then uses S284 attach to finalise.
 */
export async function requestBookingAddon({ req, userId, bookingId, addonId, quantity }) {
  if (!bookingId || !addonId) {
    throw new HttpError(400, 'bookingId + addonId wajib', 'IDS_REQUIRED');
  }
  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1) {
    throw new HttpError(400, 'Quantity harus angka ≥ 1', 'ADDON_BAD_QUANTITY');
  }
  if (qty > 50) {
    throw new HttpError(400, 'Quantity maksimal 50', 'ADDON_QUANTITY_TOO_LARGE');
  }

  const [booking, addon] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, bookingNo: true, status: true, jemaahUserId: true,
        paketId: true,
        jemaah: { select: { fullName: true } },
        paket: { select: { slug: true, title: true } },
      },
    }),
    db.paketAddon.findUnique({
      where: { id: addonId },
      select: { id: true, paketId: true, name: true, priceIdr: true, isActive: true },
    }),
  ]);
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  // Ownership check — same 404 anti-enumeration pattern as the rest of /saya.
  if (booking.jemaahUserId !== userId) {
    throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  }
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }
  if (!addon) throw new HttpError(404, 'Add-on tidak ditemukan', 'ADDON_NOT_FOUND');
  if (addon.paketId !== booking.paketId) {
    throw new HttpError(409, 'Add-on bukan milik paket booking ini', 'ADDON_PAKET_MISMATCH');
  }
  if (!addon.isActive) {
    throw new HttpError(409, 'Add-on tidak tersedia', 'ADDON_INACTIVE');
  }

  // Cooldown: same booking + same addon within last 6h
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3_600_000);
  const recent = await db.notification.findFirst({
    where: {
      type: 'GENERIC', channel: 'EMAIL',
      relatedEntity: 'Booking', relatedEntityId: bookingId,
      createdAt: { gte: cooldownCutoff },
      // Lookup via JSON path so we only match this kind+addon combo.
      payload: { path: '$.kind', equals: 'addon_request' },
    },
    select: { id: true, payload: true },
  });
  if (recent) {
    // Refine: only block if the same addonId is recent (different addons can co-exist)
    const p = recent.payload;
    if (p && p.addonId === addonId) {
      throw new HttpError(429,
        `Permintaan untuk add-on ini baru saja dikirim. Coba lagi setelah ${COOLDOWN_HOURS} jam atau hubungi admin langsung.`,
        'ADDON_REQUEST_COOLDOWN');
    }
  }

  const priceIdr = Number(addon.priceIdr?.toString?.() ?? addon.priceIdr) || 0;
  const lineTotal = priceIdr * qty;

  // Fan out one EMAIL per ACTIVE admin.
  const admins = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true },
  });
  if (admins.length === 0) {
    return { requested: true, enqueued: 0 }; // no admins — silently noop
  }

  const subject = `[Add-on request] ${booking.bookingNo} · ${addon.name} × ${qty}`;
  const body = [
    `Jemaah ${booking.jemaah?.fullName || '—'} meminta add-on baru:`,
    '',
    `Booking: ${booking.bookingNo}`,
    `Paket: ${booking.paket?.title || '—'}`,
    `Add-on: ${addon.name}`,
    `Harga: Rp ${priceIdr.toLocaleString('id-ID')} × ${qty} = Rp ${lineTotal.toLocaleString('id-ID')}`,
    '',
    `Buka /admin/bookings/${booking.id} → panel "Add-ons" → pilih + klik "Attach" untuk menambahkan.`,
    '',
    'totalAmount booking akan otomatis bertambah setelah attach. Konfirmasi harga ke jemaah dulu sebelum attach jika ada negosiasi.',
  ].join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0;
  for (const a of admins) {
    try {
      const r = await enqueueNotification({
        type: 'GENERIC', channel: 'EMAIL',
        recipientEmail: a.email,
        subject, body,
        payload: {
          kind: 'addon_request',
          bookingNo: booking.bookingNo,
          addonId, addonName: addon.name,
          quantity: qty, priceIdr, lineTotal,
          jemaahName: booking.jemaah?.fullName,
          fromUserId: userId,
        },
        relatedEntity: 'Booking', relatedEntityId: bookingId,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
    } catch (err) {
      console.warn(`[requestBookingAddon] ${a.email} failed:`, err?.message || err);
    }
  }
  return { requested: true, enqueued, adminCount: admins.length };
}
