// Stage 108 — outbound webhook dispatcher.
//
// Partner systems subscribe via the Webhook model + listen for events.
// When `dispatchEvent('booking.created', payload)` fires, we look up
// every ACTIVE subscription whose `events` JSON includes the event name
// AND POST to its URL with an HMAC-SHA256 signature header.
//
// Signature header: `X-Religio-Signature: sha256=<hex>`. The payload
// signed is the raw JSON body — receivers can recompute the HMAC and
// compare via constant-time compare to verify authenticity.
//
// Posture: fire-and-forget per-subscription. One bad URL doesn't slow
// down the others. Per-subscription failures stamp `lastError + lastStatus`
// for diagnostics but don't queue retries — webhook semantics are
// "at-most-once, partner-side idempotency"; if a partner needs retries
// they can poll their own delivery log.
//
// **Built-in fetch timeout (8s)** — slow partners shouldn't tie up the
// caller's process. AbortController + setTimeout cancels the connection.

import { createHmac } from 'node:crypto';
import { db } from '../lib/db.js';

const DEFAULT_TIMEOUT_MS = 8_000;

// Canonical event names. Keep this list narrow + stable — every name is
// a public contract with subscribers. Adding is cheap; renaming breaks
// every integration.
export const EVENT_NAMES = [
  'booking.created',
  'booking.lunas',
  'booking.cancelled',
  'payment.received',
  'refund.issued',
  'komisi.payout',
];

export function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Stage 109 — exponential backoff schedule. Mirrors notif retry (5nn).
 * After the 5th failure the row is terminal (nextRetryAt=null, status=FAILED).
 */
const BACKOFF_MS = [
  60_000,            // 1 min  → after 1st failure
  5 * 60_000,        // 5 min
  30 * 60_000,       // 30 min
  2 * 60 * 60_000,   // 2 h
  12 * 60 * 60_000,  // 12 h
];
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MS.length;

function nextDelayMs(failedAttemptCount) {
  return BACKOFF_MS[failedAttemptCount - 1] ?? null;
}

/**
 * Dispatch an event to all ACTIVE subscriptions whose `events` array
 * contains the event name. Inserts a WebhookDelivery row per match,
 * then attempts each delivery once. Failures get a PENDING retry slot
 * (or FAILED if max attempts already burned through).
 *
 * @returns {Promise<{matched:number, delivered:number, failed:number, queued:number}>}
 */
export async function dispatchEvent(eventName, payload) {
  const subs = await db.webhook.findMany({
    where: { status: 'ACTIVE' },
    // S118: prev* fields needed so attemptDelivery can dual-sign during
    // a rotation grace window.
    select: { id: true, url: true, secret: true, prevSecret: true, prevSecretExpiresAt: true, events: true },
  });
  const matched = subs.filter((s) => {
    const list = Array.isArray(s.events) ? s.events : [];
    return list.includes(eventName);
  });
  if (matched.length === 0) return { matched: 0, delivered: 0, failed: 0, queued: 0 };

  const body = JSON.stringify({ event: eventName, ts: new Date().toISOString(), payload });

  let delivered = 0, failed = 0, queued = 0;
  await Promise.all(matched.map(async (s) => {
    const signature = sign(s.secret, body);
    // Pre-insert a delivery row so even a fetch-throwing crash leaves a trail.
    const delivery = await db.webhookDelivery.create({
      data: {
        webhookId: s.id, eventName, payload: body, signature,
        status: 'PENDING', attemptCount: 0,
      },
    }).catch((err) => {
      console.warn('[webhook] delivery row create failed:', err?.message || err);
      return null;
    });
    const result = await attemptDelivery(s, body, signature, eventName, delivery, 1);
    if (result.ok) delivered += 1;
    else if (result.terminal) failed += 1;
    else queued += 1;
  }));

  return { matched: matched.length, delivered, failed, queued };
}

/**
 * Stage 109 — one delivery attempt. Caller passes `attempt` (1-indexed).
 * On success: marks SUCCEEDED. On failure: increments attempt, schedules
 * next retry per backoff, or marks FAILED at MAX. Also updates the parent
 * Webhook's diagnostic columns (lastFiredAt etc).
 */
async function attemptDelivery(sub, body, signature, eventName, delivery, attempt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), DEFAULT_TIMEOUT_MS);
  let status = null, err = null, ok = false;
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Religio-Signature': signature,
      'X-Religio-Event': eventName,
    };
    // Stage 119 — Idempotency-Key tied to the persisted delivery row id.
    // Partners can dedupe across our retries (e.g. their endpoint actually
    // succeeded but timed out responding — our retry shouldn't double-bill
    // them on their side). Skipped when there's no delivery row (e.g. a
    // pre-S109 caller, though that path is gone in practice).
    if (delivery?.id) headers['Idempotency-Key'] = delivery.id;
    // Stage 118 — during the secret rotation grace window, ALSO sign with
    // the previous secret so partners verifying against either key still
    // accept the request. After expiry, only the current signature ships.
    if (sub.prevSecret && sub.prevSecretExpiresAt && new Date(sub.prevSecretExpiresAt) > new Date()) {
      headers['X-Religio-Signature-Prev'] = sign(sub.prevSecret, body);
    }
    const res = await fetch(sub.url, {
      method: 'POST', headers, body, signal: ctrl.signal,
    });
    status = res.status;
    ok = res.ok;
    if (!ok) err = `HTTP ${res.status}`;
  } catch (e) {
    err = String(e?.message || e).slice(0, 500);
  } finally {
    clearTimeout(timer);
  }

  const now = new Date();
  if (delivery) {
    const patch = {
      attemptCount: attempt,
      lastAttemptAt: now,
      lastStatusCode: status,
      lastError: err,
    };
    if (ok) {
      patch.status = 'SUCCEEDED';
      patch.nextRetryAt = null;
    } else {
      // Schedule next retry or mark terminal FAILED
      const delay = attempt < MAX_DELIVERY_ATTEMPTS ? nextDelayMs(attempt) : null;
      patch.status = delay != null ? 'PENDING' : 'FAILED';
      patch.nextRetryAt = delay != null ? new Date(now.getTime() + delay) : null;
    }
    await db.webhookDelivery.update({ where: { id: delivery.id }, data: patch })
      .catch(() => {});
  }

  // Parent diag — last-fired snapshot regardless of attempt count
  await db.webhook.update({
    where: { id: sub.id },
    data: { lastFiredAt: now, lastStatus: status, lastError: err, lastEventName: eventName },
  }).catch(() => {});

  return {
    ok,
    terminal: !ok && attempt >= MAX_DELIVERY_ATTEMPTS,
  };
}

/**
 * Stage 117 — admin "fire a synthetic event" probe. Lets admin verify
 * partner endpoint reachability + signature acceptance during onboarding
 * without waiting for a real booking. Returns the HTTP response shape
 * (status + first 500 chars of body) for inline display.
 *
 * Does NOT insert a WebhookDelivery row + does NOT bump lastFiredAt —
 * one-shot manual probe, kept out of the diagnostic surfaces. The
 * partner endpoint sees the same shape a real event would, plus an
 * `X-Religio-Test: true` header so partners can short-circuit if they
 * want to suppress test events in their logs.
 */
export async function testFireWebhook({ webhook, eventName = 'test.ping', customPayload = null }) {
  if (!webhook?.url || !webhook?.secret) {
    return { ok: false, error: 'webhook missing url/secret' };
  }
  const samples = {
    'test.ping': { ts: new Date().toISOString(), note: 'admin test-fire from /admin/webhooks' },
    'booking.created': {
      bookingId: 'demo-bk-123', bookingNo: 'RP-TEST-00001',
      status: 'PENDING', totalAmount: 10_000_000, kelas: 'QUAD', paxCount: 2,
      paketSlug: 'demo-paket', agentSlug: 'demo-agent', jemaahName: 'Demo Jemaah',
    },
    'payment.received': {
      bookingId: 'demo-bk-123', bookingNo: 'RP-TEST-00001', paymentId: 'demo-pay',
      amount: 3_000_000, method: 'TRANSFER', currency: 'IDR', bookingStatus: 'DP_PAID',
    },
    'booking.lunas': {
      bookingId: 'demo-bk-123', bookingNo: 'RP-TEST-00001',
      totalAmount: 10_000_000, finalPaymentId: 'demo-pay-final',
    },
    'refund.issued': {
      bookingId: 'demo-bk-123', bookingNo: 'RP-TEST-00001',
      refundAmount: 2_000_000, fullRefund: false, reason: 'admin test-fire',
      bookingStatus: 'CANCELLED',
    },
  };
  const payload = customPayload || samples[eventName] || samples['test.ping'];
  const body = JSON.stringify({ event: eventName, ts: new Date().toISOString(), payload });
  const signature = sign(webhook.secret, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Religio-Signature': signature,
        'X-Religio-Event': eventName,
        'X-Religio-Test': 'true',
      },
      body, signal: ctrl.signal,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 500),
      bodyTruncated: text.length > 500,
      signature,
      sentBody: body,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err).slice(0, 500),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stage 109 — retry job. Picks PENDING deliveries whose nextRetryAt has
 * elapsed and re-fires them. Run via `npm run job:retry-webhooks` cron
 * (every 2 min) or HTTP trigger.
 */
export async function processPendingDeliveries({ limit = 50 } = {}) {
  const now = new Date();
  const due = await db.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      nextRetryAt: { lte: now },
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
    },
    take: limit,
    orderBy: { nextRetryAt: 'asc' },
    include: {
      // S118: prev* fields needed for dual-sign during rotation grace window.
      webhook: { select: { id: true, url: true, secret: true, prevSecret: true, prevSecretExpiresAt: true, status: true } },
    },
  });
  let processed = 0, succeeded = 0, failed = 0, requeued = 0, skipped = 0;
  for (const d of due) {
    processed += 1;
    // If the sub was suspended between attempts, skip without burning a retry
    // — admin clearly doesn't want this firing right now.
    if (!d.webhook || d.webhook.status !== 'ACTIVE') {
      skipped += 1;
      continue;
    }
    const r = await attemptDelivery(
      d.webhook, d.payload, d.signature, d.eventName, d, d.attemptCount + 1,
    );
    if (r.ok) succeeded += 1;
    else if (r.terminal) failed += 1;
    else requeued += 1;
  }
  return { processed, succeeded, failed, requeued, skipped };
}

// ─── Admin CRUD ──────────────────────────────────────────────
import { HttpError } from '../middleware/error.js';
import { audit } from '../lib/audit.js';
import { randomBytes } from 'node:crypto';

const URL_RE = /^https?:\/\/.+/i;

export async function listWebhooks() {
  return db.webhook.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { createdBy: { select: { email: true } } },
  });
}

export async function createWebhook({ req, actor, url, events, description }) {
  if (!URL_RE.test(url || '')) throw new HttpError(400, 'URL harus http(s)://', 'BAD_URL');
  const cleanEvents = Array.isArray(events)
    ? events.filter((e) => EVENT_NAMES.includes(e))
    : [];
  if (cleanEvents.length === 0) throw new HttpError(400, 'Pilih minimal satu event', 'NO_EVENTS');

  const secret = randomBytes(32).toString('hex');
  const created = await db.webhook.create({
    data: {
      url, secret, events: cleanEvents,
      description: (description || '').trim() || null,
      createdById: actor?.id || null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'Webhook', entityId: created.id,
    after: { url, events: cleanEvents, description: created.description },
  });
  return created;
}

export async function updateWebhookStatus({ req, actor, id, status }) {
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
    throw new HttpError(400, 'Status tidak valid', 'BAD_STATUS');
  }
  const before = await db.webhook.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Webhook tidak ditemukan', 'WEBHOOK_NOT_FOUND');
  if (before.status === status) return before;
  const updated = await db.webhook.update({ where: { id }, data: { status } });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Webhook', entityId: id,
    before: { status: before.status },
    after: { status },
  });
  return updated;
}

/**
 * Stage 118 — rotate a webhook's signing secret with an overlap window.
 *
 *   - New secret minted + stored as `secret`
 *   - Old secret moves to `prevSecret`, expiry = now + `graceHours`
 *   - During the grace window every outbound POST carries TWO headers:
 *       X-Religio-Signature       (signed with the NEW secret)
 *       X-Religio-Signature-Prev  (signed with the OLD secret)
 *     so partners can verify against EITHER while they swap config.
 *
 * Returns the new plaintext secret ONCE (admin must surface it via the
 * route response — we never store anything retrievable afterwards).
 *
 * If a previous rotation hasn't yet expired and admin rotates again,
 * the in-flight prev is replaced by the previously-current secret; the
 * older one disappears (admin has only ever advertised TWO secrets to
 * partners — current + prev — so the 3rd-most-recent isn't useful).
 */
export async function rotateWebhookSecret({ req, actor, id, graceHours = 24 }) {
  const before = await db.webhook.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Webhook tidak ditemukan', 'WEBHOOK_NOT_FOUND');

  const grace = Math.max(1, Math.min(168, parseInt(graceHours, 10) || 24));
  const newSecret = randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + grace * 60 * 60_000);
  const updated = await db.webhook.update({
    where: { id },
    data: {
      secret: newSecret,
      prevSecret: before.secret,
      prevSecretExpiresAt: expiry,
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Webhook', entityId: id,
    before: { secretRotated: true },
    after: { secretRotated: true, prevSecretExpiresAt: expiry, graceHours: grace },
  });
  return { webhook: updated, newSecret, prevSecretExpiresAt: expiry };
}

export async function deleteWebhook({ req, actor, id }) {
  const before = await db.webhook.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Webhook tidak ditemukan', 'WEBHOOK_NOT_FOUND');
  await db.webhook.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Webhook', entityId: id,
    before: { url: before.url, events: before.events },
  });
  return { id };
}
