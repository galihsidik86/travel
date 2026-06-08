// Stage 77 — sign/verify wrapped URLs in notification bodies.
//
// Format: <BASE>/r/<notifId>.<base64url(url)>.<sig>
//   sig = first 16 hex chars of HMAC-SHA256(secret, `${notifId}.${b64url}`)
//
// Why first-16: short enough that emails don't show ugly URLs but long
// enough that brute-forcing valid signatures is impractical (10^19 space).
// HMAC keys on env.JWT_SECRET — same secret the auth layer trusts, so no
// new secret to rotate.

import { createHmac } from 'node:crypto';
import { env } from '../env.js';

const SIG_LEN = 16;

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}
function sign(payload) {
  return createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex').slice(0, SIG_LEN);
}

/**
 * Encode a target URL into a tracked redirect URL. When `PUBLIC_BASE_URL`
 * is configured (production), returns an absolute URL — required for WA
 * (S85), where clients only auto-detect URLs with scheme + host. Without
 * the env, falls back to a path-only `/r/<token>` (backwards-compatible
 * with the original S77 wrap shape, and fine for email clients that
 * render `<a>` tags from the surrounding HTML).
 *
 * Only http(s) absolute or absolute-path URLs are tracked. Other inputs
 * (mailto: tel: anchors) pass through unwrapped — the redirect URL would
 * be opaque to the email client anyway.
 */
export function wrapUrl(notifId, url) {
  if (!notifId || !url) return url;
  if (!/^https?:\/\//.test(url) && !url.startsWith('/')) return url;
  const enc = b64url(url);
  const sig = sign(`${notifId}.${enc}`);
  const path = `/r/${notifId}.${enc}.${sig}`;
  const base = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/$/, '') : '';
  return base + path;
}

/**
 * Verify + decode a tracked redirect token. Returns `{ notifId, url }`
 * on success, null on any tampering or malformed input. Constant-time
 * compare on the signature prevents timing attacks.
 */
export function unwrapToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [notifId, enc, sig] = parts;
  if (!notifId || !enc || sig.length !== SIG_LEN) return null;
  const expected = sign(`${notifId}.${enc}`);
  // Avoid timing attacks via constant-time compare
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (mismatch !== 0) return null;
  try {
    return { notifId, url: b64urlDecode(enc) };
  } catch {
    return null;
  }
}
