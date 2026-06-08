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
 * Dispatch an event to all ACTIVE subscriptions whose `events` array
 * contains the event name. Each delivery is independent; one failure
 * never blocks the others.
 *
 * @param {string} eventName  one of EVENT_NAMES
 * @param {object} payload    JSON-serialisable
 * @returns {Promise<{matched:number, delivered:number, failed:number}>}
 */
export async function dispatchEvent(eventName, payload) {
  // Pull all ACTIVE rows. We don't push the JSON `events` filter into
  // the SQL because MySQL JSON contains queries are awkward + this
  // table is small (sub-100 rows in realistic setups). Filter in JS.
  const subs = await db.webhook.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, url: true, secret: true, events: true },
  });
  const matched = subs.filter((s) => {
    const list = Array.isArray(s.events) ? s.events : [];
    return list.includes(eventName);
  });
  if (matched.length === 0) return { matched: 0, delivered: 0, failed: 0 };

  const body = JSON.stringify({ event: eventName, ts: new Date().toISOString(), payload });

  let delivered = 0, failed = 0;
  await Promise.all(matched.map(async (s) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), DEFAULT_TIMEOUT_MS);
    let status = null, err = null;
    try {
      const res = await fetch(s.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Religio-Signature': sign(s.secret, body),
          'X-Religio-Event': eventName,
        },
        body,
        signal: ctrl.signal,
      });
      status = res.status;
      if (!res.ok) {
        err = `HTTP ${res.status}`;
        failed += 1;
      } else {
        delivered += 1;
      }
    } catch (e) {
      err = String(e?.message || e).slice(0, 500);
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
    await db.webhook.update({
      where: { id: s.id },
      data: { lastFiredAt: new Date(), lastStatus: status, lastError: err, lastEventName: eventName },
    }).catch(() => { /* don't let the diag patch hide the actual delivery result */ });
  }));

  return { matched: matched.length, delivered, failed };
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
