// Double-submit cookie CSRF protection.
//
// Strategy:
//   1. On every request, ensure `rp_csrf` cookie exists (32-byte random hex).
//      The cookie is NON-httpOnly so client JS can read it and echo it back.
//   2. On state-changing requests (POST/PUT/PATCH/DELETE), require the cookie
//      value to match either `X-CSRF-Token` header OR `_csrf` body field.
//   3. Skip GET/HEAD/OPTIONS (read-only — no state change to protect) and
//      paths that have their own auth (webhooks signed by upstream).
//
// Why double-submit cookie? We use stateless JWT in an httpOnly cookie. The
// attacker site can trigger a form POST that auto-sends the JWT cookie, but
// cross-site JS cannot read OUR cookies — so it cannot copy the CSRF value
// into the form. The match check fails → 403.
//
// Token rotation: we DON'T rotate per-request. The cookie persists across
// the JWT session, refreshed only when absent. This is the standard
// double-submit pattern; per-request rotation needs server-side session
// storage which we deliberately don't have.
import crypto from 'node:crypto';

export const CSRF_COOKIE = 'rp_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const CSRF_BODY_FIELD = '_csrf';
const TOKEN_BYTES = 32;

// Paths that bypass CSRF entirely. Webhooks authenticate via upstream
// signatures (Midtrans SHA512); health is read-only.
const SKIP_PATH_PREFIXES = [
  '/api/payments/midtrans/webhook',
  '/api/health',
  // S111 — inbound webhook receivers verify signatures per source;
  // CSRF cookies don't reach them anyway (partners don't have our cookies).
  '/api/webhook-in/',
];

function shouldSkip(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  return SKIP_PATH_PREFIXES.some((p) => req.path.startsWith(p));
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// Constant-time compare to avoid timing leaks on the token value.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * CSRF middleware factory. Place AFTER cookieParser + body parsers, BEFORE
 * any route that mutates state.
 */
export function csrfProtection({ cookieSecure = false } = {}) {
  return function csrf(req, res, next) {
    // Ensure cookie exists. We mint a token on first visit and on any
    // request where the cookie was cleared. Same cookie value lives for the
    // session lifetime.
    let token = req.cookies?.[CSRF_COOKIE];
    if (!token) {
      token = newToken();
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false,        // MUST be readable by client JS
        sameSite: 'lax',
        secure: cookieSecure,
        path: '/',
      });
    }
    // Expose to templates
    res.locals.csrfToken = token;

    if (shouldSkip(req)) return next();

    const submitted = req.get(CSRF_HEADER) || req.body?.[CSRF_BODY_FIELD];
    if (!submitted || !safeEqual(submitted, token)) {
      res.status(403);
      // JSON for API, HTML for browser-visible POSTs
      if (req.path.startsWith('/api/')) {
        return res.json({
          error: { code: 'CSRF_FAILED', message: 'CSRF token tidak valid atau kosong' },
        });
      }
      return res.type('text/plain').send('CSRF token tidak valid atau kosong');
    }

    next();
  };
}
