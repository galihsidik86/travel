// Stage 197 — public voucher verification page. Anyone scanning a
// voucher QR (from S195) lands here; if the HMAC signature matches,
// the page shows minimal confirmation that the voucher is real.
//
// NO authentication required — the QR is the credential. The HMAC
// proves "this URL came from Religio Pro's voucher generator", and
// since we only show booking-no + paket title + first-name + status,
// there's no PII leak even if a URL is shared.

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { db } from '../lib/db.js';
import { verifyVoucherSig } from '../lib/voucherVerifyToken.js';

const router = Router();

router.get(
  '/:bookingId',
  asyncHandler(async (req, res) => {
    const { bookingId } = req.params;
    const sig = (req.query.sig || '').toString();
    const ok = verifyVoucherSig(bookingId, sig);

    let booking = null;
    if (ok) {
      booking = await db.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true, bookingNo: true, status: true,
          kelas: true, paxCount: true,
          paket: { select: { title: true, departureDate: true, slug: true } },
          jemaah: { select: { fullName: true } },
        },
      });
    }
    // First-name only: anti-PII reveal even on a valid scan
    let firstName = null;
    if (booking?.jemaah?.fullName) {
      firstName = booking.jemaah.fullName.trim().split(/\s+/)[0];
    }
    res.render('voucher-verify', {
      ok: ok && !!booking,
      booking, firstName,
    });
  }),
);

export default router;
