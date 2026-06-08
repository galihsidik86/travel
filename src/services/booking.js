import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { findPrice, getAgentBySlug } from './paket.js';
import { notifyBookingCreated } from './notifications.js';

const KELAS_VALUES = new Set(['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP']);

/**
 * Create a booking (publicly callable from the paket-detail form).
 * - Anonymous-friendly: spawns a fresh JemaahProfile for every submission.
 * - Agent lock-in: if `agentSlug` resolves to an AgentProfile, the booking
 *   captures both the FK (agentId) and a slug snapshot (agentSlugCap) so
 *   reattribution audits survive renames.
 * - Logged-in JEMAAH self-booking (5t): when `loggedInUser.role === 'JEMAAH'`,
 *   the booking is auto-linked (`jemaahUserId` set) and the user's canonical
 *   JemaahProfile is reused — no new profile spawned, no later claim needed.
 *
 * - Admin-created booking (5w): pass `adminCreator = {id, email, role}` when
 *   staff books on behalf of a walk-in. `loggedInUser` is ignored (admin is
 *   not the jemaah), audit attributes the row to the admin, and the after
 *   payload carries `adminCreated: true`.
 *
 * @returns {{ booking, agent, paket, jemaah, selfBooked }}
 */
export async function createBooking({ req, paketSlug, agentSlug, fullName, phone, kelas, paxCount, notes, loggedInUser = null, adminCreator = null, visitorAttribution = null }) {
  // Admin booking-on-behalf overrides the loggedInUser linking — the admin
  // session is the actor, not the jemaah.
  if (adminCreator) loggedInUser = null;
  if (!KELAS_VALUES.has(kelas)) {
    throw new HttpError(400, 'Kelas kamar tidak valid', 'INVALID_KELAS');
  }
  const pax = Number.isFinite(+paxCount) ? Math.max(1, Math.min(20, parseInt(paxCount, 10))) : 1;

  // Paket must be active and have prices loaded
  const paket = await db.paket.findFirst({
    where: { slug: paketSlug, deletedAt: null, status: 'ACTIVE' },
    include: { prices: true },
  });
  if (!paket) {
    throw new HttpError(404, 'Paket tidak ditemukan atau tidak aktif', 'PAKET_NOT_FOUND');
  }
  if (paket.manifestClosesAt && paket.manifestClosesAt < new Date()) {
    throw new HttpError(409, 'Manifes paket ini sudah ditutup', 'MANIFEST_CLOSED');
  }
  if (paket.kursiTerisi + pax > paket.kursiTotal) {
    throw new HttpError(409, 'Kursi tersisa tidak mencukupi', 'KURSI_INSUFFICIENT');
  }

  const price = findPrice(paket, kelas);
  if (!price) {
    throw new HttpError(400, `Harga untuk kelas ${kelas} belum ditetapkan`, 'PRICE_NOT_SET');
  }

  const totalAmount = Number(price.priceIdr) * pax;

  // Agent lock-in
  const agent = await getAgentBySlug(agentSlug);
  const agentSlugCap = agent ? agent.slug : agentSlug?.trim().toLowerCase() || null;

  // Self-booking: reuse the logged-in JEMAAH's canonical profile (so a returning
  // jemaah doesn't accumulate one profile per booking). Falls through to "spawn
  // fresh JemaahProfile" for anonymous users.
  let reusedProfile = null;
  let selfBooked = false;
  if (loggedInUser && loggedInUser.role === 'JEMAAH') {
    reusedProfile = await db.jemaahProfile.findFirst({ where: { userId: loggedInUser.id } });
    selfBooked = !!reusedProfile;
  }

  const bookingNo = await generateBookingNo();

  const result = await db.$transaction(async (tx) => {
    const jemaah = reusedProfile
      ? reusedProfile
      : await tx.jemaahProfile.create({
          data: { fullName: fullName.trim(), phone: phone.trim() },
        });

    const booking = await tx.booking.create({
      data: {
        bookingNo,
        paketId: paket.id,
        jemaahId: jemaah.id,
        jemaahUserId: selfBooked ? loggedInUser.id : null,
        agentId: agent?.id ?? null,
        agentSlugCap,
        kelas,
        paxCount: pax,
        notes: notes?.trim() || null,
        totalAmount: totalAmount.toFixed(2),
        currency: 'IDR',
        status: 'PENDING',
        // Stage 49/50/51 — attribution snapshot. visitorAttribution is
        // resolved from the rp_vis cookie in the route layer; null when
        // the booking came from a path that doesn't carry view history
        // (admin walk-in, jemaah portal /saya/paket etc.). Never mutated.
        firstViewAt: visitorAttribution?.firstViewAt ?? null,
        viewCount: visitorAttribution?.viewCount ?? 0,
        heroVariant: visitorAttribution?.heroVariant ?? null,
        utmSource:   visitorAttribution?.utmSource   ?? null,
        utmMedium:   visitorAttribution?.utmMedium   ?? null,
        utmCampaign: visitorAttribution?.utmCampaign ?? null,
      },
    });

    // Reserve seats (optimistic)
    await tx.paket.update({
      where: { id: paket.id },
      data: { kursiTerisi: { increment: pax } },
    });

    return { booking, jemaah };
  });

  await audit({
    req,
    actor: adminCreator
      ? { id: adminCreator.id, email: adminCreator.email, role: adminCreator.role }
      : selfBooked
        ? { id: loggedInUser.id, email: loggedInUser.email, role: loggedInUser.role }
        : null,
    action: 'CREATE',
    entity: 'Booking',
    entityId: result.booking.id,
    after: {
      bookingNo,
      paketSlug,
      kelas,
      paxCount: pax,
      totalAmount,
      agentSlugAttempted: agentSlug ?? null,
      agentSlugCap,
      agentMatched: !!agent,
      selfBooked,
      jemaahUserId: selfBooked ? loggedInUser.id : null,
      adminCreated: !!adminCreator,
    },
  });

  // Notif (non-blocking — service failure must not abort the booking)
  try {
    await notifyBookingCreated({
      ...result.booking,
      jemaah: result.jemaah,
      paket: { title: paket.title },
    });
  } catch (err) {
    console.error('[booking] notif failed:', err.message);
  }

  return {
    booking: result.booking,
    jemaah: result.jemaah,
    agent,
    paket,
    selfBooked,
  };
}

/**
 * Booking number scheme: RP-YYYY-NNNNN, NNNNN is sequential within the year.
 * Race-safe because uniqueness is enforced by the schema (`bookingNo @unique`)
 * and we retry on collision.
 */
async function generateBookingNo() {
  const year = new Date().getFullYear();
  const prefix = `RP-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.booking.count({
      where: { bookingNo: { startsWith: prefix } },
    });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(5, '0')}`;
    const exists = await db.booking.findUnique({ where: { bookingNo: candidate } });
    if (!exists) return candidate;
  }
  // Fallback — extremely unlikely
  return `${prefix}${Date.now().toString().slice(-6)}`;
}
