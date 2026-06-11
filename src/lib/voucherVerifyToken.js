// Stage 197 — sign/verify the public voucher verification URL embedded
// in the S195 voucher QR code. Anyone scanning the QR can confirm
// "this voucher is real" without admin login, but can't enumerate
// other booking ids (HMAC on bookingId binds the URL).
//
// Format: /v/<bookingId>?sig=<hex16>
//   sig = first 16 hex chars of HMAC-SHA256(env.JWT_SECRET, bookingId)
//
// Why first-16 (matches S77 emailClickToken): short enough that the
// QR matrix stays compact + readable on small prints, long enough
// that brute-forcing is impractical (10^19 space). HMAC keys on
// JWT_SECRET so no new secret to rotate.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

const SIG_LEN = 16;

function sign(bookingId) {
  return createHmac('sha256', env.JWT_SECRET).update(`voucher:${bookingId}`).digest('hex').slice(0, SIG_LEN);
}

/**
 * Build the full verification URL for a voucher QR. Uses PUBLIC_BASE_URL
 * when set (absolute — required so QR scans work from any QR app),
 * otherwise a relative `/v/<id>?sig=<hex>` (fine for local dev / when
 * the QR is opened by a logged-in admin scanner).
 */
export function buildVerifyUrl(bookingId) {
  if (!bookingId) return '';
  const sig = sign(bookingId);
  const base = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/$/, '') : '';
  return `${base}/v/${bookingId}?sig=${sig}`;
}

/**
 * Verify a signature for a given bookingId. Constant-time compare.
 * Returns true iff `sig` matches.
 */
export function verifyVoucherSig(bookingId, sig) {
  if (!bookingId || !sig || typeof sig !== 'string') return false;
  if (sig.length !== SIG_LEN) return false;
  const expected = sign(bookingId);
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export { SIG_LEN as VOUCHER_SIG_LEN };
