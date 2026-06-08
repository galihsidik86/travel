// Stage 17 — Web Push fan-out for admin alerts (SOS / Incidents).
//
// Email + WA already exist as the canonical channels (`notifyIncidentCreated`
// fans both out to every ACTIVE admin). Web Push adds a third layer that
// pops in real-time on whatever browser the admin has the dashboard open in,
// so they don't have to refresh their inbox to notice an OPEN SOS.
//
// Subscription model:
//   - 1 PushSubscription row per (user × browser/device).
//   - The browser-issued endpoint is the canonical identity (re-subscribing
//     the same browser returns the same endpoint). Stored as TEXT + a sha-256
//     `endpointHash` VarChar(64) for the @unique constraint (MySQL can't
//     unique a TEXT column without a key length).
//   - Cascade on user delete — a SUSPENDED + soft-deleted admin can't keep
//     receiving SOS pushes on a stale device.
//
// Fake mode: when VAPID_PUBLIC is absent, sendPushTo() logs to console
// instead of calling web-push. Subscribe/unsubscribe still work, so the
// full flow is testable without VAPID creds.

import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { env } from '../env.js';

let webpush = null;     // lazily required so missing native deps don't break boot
let mode = 'console';

export async function bootstrapWebPush() {
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE) {
    try {
      const mod = await import('web-push');
      webpush = mod.default || mod;
      webpush.setVapidDetails(env.VAPID_CONTACT, env.VAPID_PUBLIC, env.VAPID_PRIVATE);
      mode = 'web-push';
      console.log(`[push] sender = web-push (contact ${env.VAPID_CONTACT})`);
    } catch (err) {
      console.warn('[push] web-push module load failed, staying in fake mode:', err?.message || err);
    }
  } else {
    console.log('[push] sender = console (VAPID_PUBLIC absent — set to enable real push)');
  }
}

export function getPushMode() { return mode; }
export function getPublicKey() { return env.VAPID_PUBLIC || null; }

function hashEndpoint(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

/**
 * Upsert a subscription for the given user. Re-subscribing the same browser
 * (same endpoint) updates p256dh/auth/userAgent rather than creating a dupe.
 * Returns the row.
 */
export async function subscribePush({ userId, subscription, userAgent = null }) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const err = new Error('Subscription payload missing endpoint or keys');
    err.code = 'BAD_SUBSCRIPTION';
    throw err;
  }
  const endpointHash = hashEndpoint(subscription.endpoint);
  const row = await db.pushSubscription.upsert({
    where: { endpointHash },
    create: {
      userId,
      endpoint: subscription.endpoint,
      endpointHash,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
    },
    update: {
      userId,                           // re-attach if a different user picked up this browser
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      lastUsedAt: new Date(),
    },
  });
  return row;
}

/**
 * Remove a subscription by its browser endpoint (preferred — the client knows
 * its own endpoint), or by id (admin remove from another device).
 */
export async function unsubscribePush({ endpoint = null, id = null, userId = null }) {
  if (!endpoint && !id) return { deleted: 0 };
  const where = id
    ? { id, ...(userId ? { userId } : {}) }
    : { endpointHash: hashEndpoint(endpoint), ...(userId ? { userId } : {}) };
  const r = await db.pushSubscription.deleteMany({ where });
  return { deleted: r.count };
}

/**
 * Stage 97 — admin debug: list ALL push subscriptions in the system,
 * grouped by user role + active state. Returns the lean subset needed
 * by the debug view; endpoint kept as a short hash preview so the
 * page doesn't leak the raw push URL.
 */
export async function listAllPushSubscriptionsForDebug() {
  const subs = await db.pushSubscription.findMany({
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
    include: {
      user: { select: { id: true, email: true, fullName: true, role: true, status: true, deletedAt: true } },
    },
  });
  return subs.map((s) => ({
    id: s.id,
    userId: s.userId,
    user: s.user,
    userAgent: s.userAgent,
    endpointPreview: s.endpointHash ? s.endpointHash.slice(0, 12) + '…' : '—',
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    stale: s.user?.deletedAt != null || s.user?.status !== 'ACTIVE',
  }));
}

/**
 * Stage 97 — send a synthetic test push to ONE subscription. Lets admin
 * verify VAPID config + the SW push handler end-to-end without waiting
 * for a real event. Returns the same shape as sendOne (ok/status/gone).
 */
export async function sendTestPushToSubscription(subId) {
  const sub = await db.pushSubscription.findUnique({ where: { id: subId } });
  if (!sub) return { ok: false, status: 'not_found' };
  return sendOne(sub, {
    title: 'Tes push dari /admin/push-debug',
    body: 'Kalau Anda baca ini di browser, push notif berfungsi.',
    url: '/admin/push-debug',
    tag: 'push-debug-' + Date.now(),
  });
}

export async function listMyPushSubscriptions(userId) {
  return db.pushSubscription.findMany({
    where: { userId },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true, endpointHash: true },
  });
}

/**
 * Internal: send one push to one subscription. In fake mode, just logs.
 * In web-push mode, calls webpush.sendNotification and on 404/410 (gone)
 * deletes the stale subscription row.
 *
 * Returns { ok, status, deleted }.
 */
async function sendOne(sub, payload) {
  if (mode !== 'web-push' || !webpush) {
    console.log(`[push fake] → ${sub.userAgent || sub.id} · ${payload.title || '(no title)'}`);
    return { ok: true, status: 'fake' };
  }
  try {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    await db.pushSubscription.update({
      where: { id: sub.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {});
    return { ok: true, status: 'sent' };
  } catch (err) {
    const code = err.statusCode || err.status;
    // 404 / 410 → endpoint dead, scrub the row to keep the table bounded.
    if (code === 404 || code === 410) {
      await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      return { ok: false, status: 'gone', deleted: true };
    }
    console.warn('[push] sendOne failed:', code, err?.message || err);
    return { ok: false, status: 'error', error: String(err?.message || err) };
  }
}

/**
 * Fan-out a push payload to every PushSubscription owned by ANY ACTIVE
 * OWNER/SUPERADMIN/MANAJER_OPS user. Used by `notifyIncidentCreated` to
 * surface SOS in the browser the moment they land in the DB.
 *
 * Payload shape (received in shared/sw.js push handler):
 *   { title: string, body: string, url: string, tag?: string, icon?: string }
 *
 * Returns { delivered, failed, gone } — counts only. Never throws.
 */
/**
 * Stage 93 — fan out a push payload to every PushSubscription owned by
 * a SPECIFIC user (intended for jemaah). Mirrors pushToAdmins but scoped
 * by userId — used by notifyBookingCreated etc. to push booking/payment
 * notifs in real-time when the jemaah has the /saya PWA installed.
 *
 * Silent when userId is missing or no subscriptions exist (jemaah didn't
 * install the PWA / disabled notifications). Push is purely additive
 * here — the EMAIL/WA channels still fire via the queue.
 */
export async function pushToUser(userId, payload) {
  if (!userId) return { delivered: 0, failed: 0, gone: 0, skipped: true };
  try {
    const subs = await db.pushSubscription.findMany({
      where: {
        userId,
        user: { status: 'ACTIVE', deletedAt: null },
      },
    });
    if (subs.length === 0) return { delivered: 0, failed: 0, gone: 0 };
    const results = await Promise.all(subs.map((s) => sendOne(s, payload)));
    let delivered = 0, failed = 0, gone = 0;
    for (const r of results) {
      if (r.ok) delivered += 1;
      else if (r.status === 'gone') gone += 1;
      else failed += 1;
    }
    return { delivered, failed, gone };
  } catch (err) {
    console.warn('[push] pushToUser failed:', err?.message || err);
    return { delivered: 0, failed: 0, gone: 0, error: String(err?.message || err) };
  }
}

export async function pushToAdmins(payload) {
  try {
    const subs = await db.pushSubscription.findMany({
      where: {
        user: {
          role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });
    if (subs.length === 0) return { delivered: 0, failed: 0, gone: 0 };
    const results = await Promise.all(subs.map((s) => sendOne(s, payload)));
    let delivered = 0, failed = 0, gone = 0;
    for (const r of results) {
      if (r.ok) delivered += 1;
      else if (r.status === 'gone') gone += 1;
      else failed += 1;
    }
    return { delivered, failed, gone };
  } catch (err) {
    console.warn('[push] pushToAdmins failed:', err?.message || err);
    return { delivered: 0, failed: 0, gone: 0, error: String(err?.message || err) };
  }
}
