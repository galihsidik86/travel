// Stage 111 — inbound webhook receiver.
//
// Per-source rules live in VERIFIERS + HANDLERS below. Adding a new
// source = add an entry to each map; the route stays generic.
//
// Verifier signature: `(body: string, headers: object) => boolean | null`
//   - return `true`/`false` to set signatureValid + drive REJECTED status
//   - return `null` to leave signatureValid null (no rule configured)
//
// Handler signature: `(payload: object, headers: object) => Promise<void>`
//   - run AFTER persistence — failures just stamp HANDLER_ERROR
//   - skipped entirely when signatureValid === false (REJECTED)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../lib/db.js';

// ─── Per-source verifiers ────────────────────────────────────
// Convention: env var WEBHOOK_IN_<SOURCE>_SECRET holds the shared secret.
// Verifier returns null if env is missing (treats source as accept-anything
// for dev; admin can rotate to a real secret without touching code).
function hmacVerifier(envKey, headerName, algo = 'sha256') {
  return (body, headers) => {
    const secret = process.env[envKey];
    if (!secret) return null;  // no rule configured
    const sig = (headers[headerName.toLowerCase()] || '').toString();
    if (!sig) return false;
    // Accept both "sha256=<hex>" and bare hex
    const expectedHex = createHmac(algo, secret).update(body).digest('hex');
    const candidate = sig.replace(/^sha256=/i, '').trim();
    if (candidate.length !== expectedHex.length) return false;
    try {
      return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expectedHex, 'hex'));
    } catch (_e) {
      return false;
    }
  };
}

export const VERIFIERS = {
  // Fonnte (WA gateway) — they use a custom token header in production
  // setups; the exact header varies by config. Configurable per env.
  fonnte:   hmacVerifier('WEBHOOK_IN_FONNTE_SECRET', 'x-fonnte-signature'),
  zapier:   hmacVerifier('WEBHOOK_IN_ZAPIER_SECRET', 'x-zapier-signature'),
  generic:  hmacVerifier('WEBHOOK_IN_GENERIC_SECRET', 'x-religio-signature'),
};

// ─── Per-source handlers ─────────────────────────────────────
// Empty map = pure passive receiver. Add handlers when wiring an
// integration (e.g. fonnte delivery receipt → flip Notification.status).
export const HANDLERS = {
  // fonnte: async (payload, headers) => { ... },
};

const KNOWN_SOURCES = new Set([...Object.keys(VERIFIERS), ...Object.keys(HANDLERS)]);

/**
 * Process one inbound POST. Always persists; signatureValid + status
 * reflect whether it would be acted on.
 *
 * @param {string} source       URL segment name
 * @param {string} rawBody      raw string body (signature verification uses this)
 * @param {object} headers      lowercased header map
 * @returns {Promise<{id, status, signatureValid}>}
 */
export async function receiveInbound({ source, rawBody, headers }) {
  const verifier = VERIFIERS[source];
  const sigValid = verifier ? verifier(rawBody, headers) : null;

  let status = 'RECEIVED';
  if (sigValid === false) status = 'REJECTED';

  // Capture only the headers we care about — avoid storing cookies / auth
  // / random vendor instrumentation. Whitelist by prefix.
  const kept = {};
  for (const k of Object.keys(headers)) {
    if (k.startsWith('x-') || k === 'content-type' || k === 'user-agent') {
      kept[k] = headers[k];
    }
  }

  let row;
  try {
    row = await db.inboundWebhook.create({
      data: {
        source: source.slice(0, 80),
        headers: kept,
        payload: rawBody.slice(0, 2_000_000),  // 2MB cap
        signatureValid: sigValid,
        status,
      },
    });
  } catch (err) {
    console.error('[inbound-webhook] persist failed:', err?.message || err);
    return { id: null, status: 'PERSIST_ERROR', signatureValid: sigValid };
  }

  // Don't run a handler on rejected payloads — that's the whole point.
  if (status === 'REJECTED') return { id: row.id, status, signatureValid: sigValid };

  const handler = HANDLERS[source];
  if (handler) {
    try {
      let parsed = null;
      try { parsed = JSON.parse(rawBody); } catch (_e) { /* non-JSON; pass null */ }
      await handler(parsed, headers);
      await db.inboundWebhook.update({ where: { id: row.id }, data: { status: 'HANDLED' } });
      return { id: row.id, status: 'HANDLED', signatureValid: sigValid };
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 1000);
      await db.inboundWebhook.update({
        where: { id: row.id },
        data: { status: 'HANDLER_ERROR', handlerError: msg },
      });
      return { id: row.id, status: 'HANDLER_ERROR', signatureValid: sigValid };
    }
  }

  return { id: row.id, status, signatureValid: sigValid };
}

export async function listInbound({ source, status, limit = 100 } = {}) {
  const where = {};
  if (source) where.source = source;
  if (status) where.status = status;
  return db.inboundWebhook.findMany({
    where,
    take: limit,
    orderBy: { receivedAt: 'desc' },
  });
}

/**
 * Admin replay: re-run a stored payload through its registered handler.
 * Useful when a handler had a bug that's since been fixed.
 */
export async function replayInbound(id) {
  const row = await db.inboundWebhook.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'not_found' };
  const handler = HANDLERS[row.source];
  if (!handler) return { ok: false, reason: 'no_handler_for_source' };
  try {
    let parsed = null;
    try { parsed = JSON.parse(row.payload); } catch (_e) {}
    await handler(parsed, row.headers || {});
    await db.inboundWebhook.update({
      where: { id },
      data: { status: 'HANDLED', handlerError: null },
    });
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 1000);
    await db.inboundWebhook.update({
      where: { id },
      data: { status: 'HANDLER_ERROR', handlerError: msg },
    });
    return { ok: false, reason: 'handler_threw', error: msg };
  }
}

export { KNOWN_SOURCES };
