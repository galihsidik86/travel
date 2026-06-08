import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { optionalAuth } from '../middleware/auth.js';
import { createBooking } from '../services/booking.js';
import { getVisitorAttribution } from '../services/paketView.js';
import { db } from '../lib/db.js';

const router = Router();

// Anonymous form posts — limit per IP to slow accidental floods / spam.
const bookingLimiter = rateLimit({ windowMs: 60_000, max: 8, code: 'BOOKING_RATE_LIMITED' });

const BookingSchema = z.object({
  paketSlug: z.string().min(1).max(190),
  agentSlug: z.string().max(190).optional().nullable(),
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Nomor WhatsApp tidak valid').max(30),
  kelas: z.enum(['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP'], { errorMap: () => ({ message: 'Pilih kelas kamar' }) }),
  paxCount: z.coerce.number().int().min(1).max(20).default(1),
  notes: z.string().max(2000).optional().nullable(),
  // 5t: jemaah on the form may opt out of self-link ("Booking for someone else")
  forceAnonymous: z.preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean()).optional(),
});

router.post(
  '/',
  optionalAuth, bookingLimiter,
  asyncHandler(async (req, res) => {
    const data = BookingSchema.parse(req.body);
    const { forceAnonymous, ...inputs } = data;

    // Stage 49/50/51 — resolve attribution from the rp_vis cookie. Best-
    // effort: a missing cookie or no prior views just yields null, which
    // createBooking stores as "no attribution captured" (defaults all
    // attribution columns to NULL / 0 viewCount).
    let visitorAttribution = null;
    try {
      const visitorId = req.cookies?.rp_vis;
      if (visitorId && /^[0-9a-f]{32}$/.test(visitorId)) {
        const paket = await db.paket.findUnique({
          where: { slug: inputs.paketSlug },
          select: { id: true },
        });
        if (paket) {
          visitorAttribution = await getVisitorAttribution({
            paketId: paket.id, visitorId,
          });
        }
      }
    } catch (err) {
      console.warn('[booking] visitor-attribution lookup failed:', err?.message || err);
    }

    const { booking, agent, paket, selfBooked } = await createBooking({
      req, ...inputs,
      loggedInUser: forceAnonymous ? null : (req.user || null),
      visitorAttribution,
    });

    res.status(201).json({
      booking: {
        id: booking.id,
        bookingNo: booking.bookingNo,
        kelas: booking.kelas,
        paxCount: booking.paxCount,
        totalAmount: booking.totalAmount,
        status: booking.status,
      },
      paket: { slug: paket.slug, title: paket.title },
      agent: agent ? { slug: agent.slug, displayName: agent.displayName, whatsapp: agent.whatsapp } : null,
      selfBooked,
    });
  }),
);

export default router;
