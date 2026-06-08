import { db } from '../lib/db.js';
import { renderTemplate } from './notifTemplates.js';

// Indonesian-style thousand separator. Centralised so all templates use the
// same formatting; future i18n can swap this per locale.
const fmtRp = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');

// Pluggable sender map. Real providers (SMTP, Twilio, Fonnte) hook in here
// later by replacing the SENDERS table. Each sender returns:
//   { ok: true }                       → status SENT
//   { ok: false, error: string }       → status FAILED
//   { skip: true, reason: string }     → status SKIPPED (e.g. recipient missing)
//
// Default impl just logs to stdout — safe for dev + smoke tests. Production
// must override at boot (e.g. `setSender('EMAIL', mailgunSend)`).
const SENDERS = {
  CONSOLE: defaultConsoleSender,
  EMAIL: defaultConsoleSender,   // TODO swap to nodemailer/Mailgun adapter
  WA: defaultConsoleSender,      // TODO swap to Twilio/Fonnte adapter
};

export function setSender(channel, fn) {
  SENDERS[channel] = fn;
}

function defaultConsoleSender(n) {
  const recipient = n.recipientEmail || n.recipientPhone || '(no recipient)';
  console.log(`[notif:${n.channel}] → ${recipient} · ${n.type}`);
  if (n.subject) console.log(`  subject: ${n.subject}`);
  console.log(`  body: ${n.body.slice(0, 200)}${n.body.length > 200 ? '…' : ''}`);
  return { ok: true };
}

/**
 * Insert a notification in PENDING state. Never throws — callers can wrap
 * service writes without worrying about the notif insert breaking them.
 *
 * Optional `recipientUserId` triggers a preferences lookup (5jj): if that user
 * has a JemaahProfile and has opted out of this channel, the row is created
 * with status=SKIPPED (visible in admin viewer, not silently dropped).
 *
 * Returns the created row or null on failure (logged to console).
 */
export async function enqueueNotification({
  type, channel,
  recipientEmail, recipientPhone, recipientUserId,
  subject, body, payload,
  relatedEntity, relatedEntityId,
}) {
  try {
    // 5jj (per-channel) + per-type opt-out checks. Per-type wins for the
    // reason text — it's more actionable for the jemaah ("you turned off
    // payment notifs" vs the more general "you turned off WA").
    let optOutReason = null;
    if (recipientUserId) {
      const profile = await db.jemaahProfile.findFirst({
        where: { userId: recipientUserId },
        select: {
          id: true, notifEmail: true, notifWa: true,
          notifTypePrefs: { where: { type }, select: { enabled: true } },
        },
      });
      if (profile) {
        // Per-channel
        if (channel === 'EMAIL' && !profile.notifEmail) optOutReason = 'recipient opted out of EMAIL notifications';
        if (channel === 'WA' && !profile.notifWa) optOutReason = 'recipient opted out of WA notifications';
        // Per-type — overrides reason if explicitly disabled
        const typePref = profile.notifTypePrefs?.[0];
        if (typePref && typePref.enabled === false) {
          optOutReason = `recipient opted out of ${type} notifications`;
        }
      }
    }

    // Skip-on-no-recipient
    const hasRecipient = (channel === 'EMAIL' && recipientEmail)
      || (channel === 'WA' && recipientPhone)
      || channel === 'CONSOLE';
    const skipped = !hasRecipient || optOutReason !== null;
    const skipReason = optOutReason || (!hasRecipient ? `no recipient configured for channel ${channel}` : null);

    return await db.notification.create({
      data: {
        type, channel,
        status: skipped ? 'SKIPPED' : 'PENDING',
        recipientEmail: recipientEmail || null,
        recipientPhone: recipientPhone || null,
        recipientUserId: recipientUserId || null,
        subject: subject || null,
        body: body || '',
        payload: payload ?? undefined,
        relatedEntity: relatedEntity || null,
        relatedEntityId: relatedEntityId || null,
        sentAt: skipped ? new Date() : null,
        error: skipReason,
      },
    });
  } catch (err) {
    console.error('[notif] enqueue failed:', err.message);
    return null;
  }
}

// 5nn: backoff schedule (delay between attempts). attemptCount before
// failure → wait. After MAX_ATTEMPTS, the row is terminal (no nextRetryAt).
const BACKOFF_MS = [
  60_000,        // 1 min     → after 1st failure
  5 * 60_000,    // 5 min     → after 2nd
  30 * 60_000,   // 30 min    → after 3rd
  2 * 60 * 60_000,  // 2 h    → after 4th
  12 * 60 * 60_000, // 12 h   → after 5th
];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

function nextDelayMs(failedAttemptCount) {
  // failedAttemptCount is the count *after* the just-failed attempt.
  // index = failedAttemptCount - 1 (1st failure → BACKOFF_MS[0])
  return BACKOFF_MS[failedAttemptCount - 1] ?? null;
}

/**
 * Dispatch a single notification: call sender, persist result.
 * On FAILED, schedules the next retry per BACKOFF_MS until MAX_ATTEMPTS,
 * then leaves the row terminal (nextRetryAt = null) — the queue worker will
 * stop picking it up.
 */
export async function dispatchNotification(notif) {
  const now = new Date();
  const send = SENDERS[notif.channel];

  // Helper to compute the FAILED-state patch with retry scheduling.
  const failPatch = (errorMsg) => {
    const newCount = (notif.attemptCount ?? 0) + 1;
    const delayMs = newCount < MAX_ATTEMPTS ? nextDelayMs(newCount) : null;
    return {
      status: 'FAILED',
      error: errorMsg,
      attemptCount: newCount,
      lastAttemptAt: now,
      nextRetryAt: delayMs != null ? new Date(now.getTime() + delayMs) : null,
      sentAt: now,
    };
  };

  if (!send) {
    return db.notification.update({
      where: { id: notif.id },
      data: failPatch(`no sender for channel ${notif.channel}`),
    });
  }

  // Stage 77 — for EMAIL channel only, rewrite absolute + absolute-path
  // URLs in the body to go through /r/<token> so we can record clicks.
  // Mutates a copy of the notif object; the DB row stays unchanged so
  // admin viewers still show the original link text.
  let toSend = notif;
  if (notif.channel === 'EMAIL' && notif.body) {
    try {
      const { wrapUrl } = await import('../lib/emailClickToken.js');
      // Match http(s) URLs OR root-absolute paths. Stop at whitespace.
      const rewrite = (m) => wrapUrl(notif.id, m);
      const wrappedBody = notif.body
        // 1) absolute http(s) URLs
        .replace(/https?:\/\/[^\s)>]+/g, rewrite)
        // 2) root-absolute paths that look like internal links — match
        //    the conservative whitelist used by the notif templates:
        //    /saya, /admin, /agen, /crew, /p, /c, /a, /agen-leaderboard
        .replace(/(^|[\s(])(\/(?:saya|admin|agen|crew|p|c|a|agen-leaderboard)[^\s)>]*)/g,
                 (full, lead, path) => lead + wrapUrl(notif.id, path));
      toSend = { ...notif, body: wrappedBody };
    } catch (err) {
      console.warn('[notif] click-wrap failed (sending raw):', err?.message || err);
    }
  }

  let result;
  try {
    result = await send(toSend);
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  if (result.skip) {
    // SKIPPED is terminal — clear any pending retry so it never re-runs.
    return db.notification.update({
      where: { id: notif.id },
      data: {
        status: 'SKIPPED', error: result.reason || null,
        sentAt: now, lastAttemptAt: now, nextRetryAt: null,
        attemptCount: (notif.attemptCount ?? 0) + 1,
      },
    });
  }
  if (result.ok) {
    return db.notification.update({
      where: { id: notif.id },
      data: {
        status: 'SENT', sentAt: now, lastAttemptAt: now,
        error: null, nextRetryAt: null,
        attemptCount: (notif.attemptCount ?? 0) + 1,
      },
    });
  }
  const patch = failPatch(result.error || 'unknown sender error');
  const updated = await db.notification.update({
    where: { id: notif.id },
    data: patch,
  });

  // Stage 78 — when this attempt was the FINAL failure (terminal status:
  // nextRetryAt=null OR attemptCount >= MAX_ATTEMPTS) AND the row is an
  // EMAIL channel AND the notif type is in the "critical" set AND there's
  // a phone number on file, auto-enqueue a WA duplicate. Best-effort —
  // never throws back to the caller (the original failure is already the
  // observable signal).
  const isTerminal = patch.nextRetryAt == null;
  if (isTerminal && notif.channel === 'EMAIL' && CRITICAL_FALLBACK_TYPES.has(notif.type) && notif.recipientPhone) {
    try {
      // Idempotency: don't enqueue a second fallback if one already exists
      const existing = await db.notification.findFirst({
        where: {
          channel: 'WA',
          recipientPhone: notif.recipientPhone,
          type: notif.type,
          relatedEntity: notif.relatedEntity,
          relatedEntityId: notif.relatedEntityId,
        },
        select: { id: true },
      });
      if (!existing) {
        await enqueueNotification({
          type: notif.type, channel: 'WA',
          recipientPhone: notif.recipientPhone,
          recipientUserId: notif.recipientUserId,
          subject: notif.subject,
          body: notif.body,
          payload: { ...(notif.payload || {}), fallbackFromEmail: notif.id },
          relatedEntity: notif.relatedEntity,
          relatedEntityId: notif.relatedEntityId,
        });
      }
    } catch (err) {
      console.warn('[notif] WA fallback enqueue failed:', err?.message || err);
    }
  }

  return updated;
}

// Stage 78 — notif types that warrant a WA fallback on EMAIL terminal
// failure. Operational + jemaah-facing critical paths only. Bulk admin
// digests (DAILY/WEEKLY/CREW/etc.) deliberately excluded — those land
// in the queue dashboard if email bounces; spamming WA with weekly
// summaries would be worse than missing the email.
const CRITICAL_FALLBACK_TYPES = new Set([
  'BOOKING_CREATED',
  'PAYMENT_RECEIVED',
  'BOOKING_LUNAS',
  'REFUND_ISSUED',
  'FIRST_PAYMENT_THANKS',
  'PAYOUT_CREATED',
]);

/**
 * Process notifications ready for dispatch: any PENDING row, plus FAILED rows
 * whose backoff window has elapsed AND haven't hit MAX_ATTEMPTS yet (5nn).
 * Terminal FAILED (max attempts reached, nextRetryAt=null) are skipped.
 *
 * Used by cron + manual HTTP trigger + in-process worker.
 * Returns { processed, sent, failed, skipped }.
 */
export async function processPendingNotifications({ limit = 100 } = {}) {
  const now = new Date();
  const pending = await db.notification.findMany({
    where: {
      OR: [
        { status: 'PENDING' },
        { status: 'FAILED', nextRetryAt: { lte: now }, attemptCount: { lt: MAX_ATTEMPTS } },
      ],
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });
  let sent = 0, failed = 0, skipped = 0;
  for (const n of pending) {
    const updated = await dispatchNotification(n);
    if (updated.status === 'SENT') sent += 1;
    else if (updated.status === 'FAILED') failed += 1;
    else if (updated.status === 'SKIPPED') skipped += 1;
  }
  return { processed: pending.length, sent, failed, skipped };
}

// ─── Event helpers (call from services after the main write) ────

export async function notifyBookingCreated(booking) {
  const vars = {
    fullName: booking.jemaah?.fullName ?? 'jemaah',
    bookingNo: booking.bookingNo,
    paketTitle: booking.paket?.title ?? '-',
    kelas: booking.kelas,
    paxCount: booking.paxCount,
    totalAmountFormatted: fmtRp(booking.totalAmount),
  };
  const payload = { bookingId: booking.id, bookingNo: booking.bookingNo };
  // userId of the linked jemaah profile (when present) drives the 5jj opt-out check
  const recipientUserId = booking.jemaah?.userId ?? booking.jemaahUserId ?? null;

  const email = renderTemplate('BOOKING_CREATED', 'EMAIL', vars);
  const wa = renderTemplate('BOOKING_CREATED', 'WA', vars);

  await Promise.all([
    enqueueNotification({
      type: 'BOOKING_CREATED', channel: 'EMAIL',
      recipientEmail: booking.jemaah?.email, recipientUserId,
      subject: email.subject, body: email.body, payload,
      relatedEntity: 'Booking', relatedEntityId: booking.id,
    }),
    enqueueNotification({
      type: 'BOOKING_CREATED', channel: 'WA',
      recipientPhone: booking.jemaah?.phone, recipientUserId,
      subject: wa.subject || null, body: wa.body, payload,
      relatedEntity: 'Booking', relatedEntityId: booking.id,
    }),
  ]);
}

export async function notifyPaymentReceived({ booking, payment }) {
  const amt = Number(payment.amount?.toString?.() ?? payment.amount) || 0;
  const vars = {
    bookingNo: booking.bookingNo,
    method: payment.method,
    amountFormatted: fmtRp(amt),
  };
  const { subject, body } = renderTemplate('PAYMENT_RECEIVED', 'WA', vars);
  await enqueueNotification({
    type: 'PAYMENT_RECEIVED', channel: 'WA',
    recipientPhone: booking.jemaah?.phone,
    recipientUserId: booking.jemaah?.userId ?? booking.jemaahUserId ?? null,
    subject, body,
    payload: { bookingNo: booking.bookingNo, paymentId: payment.id, amount: amt },
    relatedEntity: 'Payment', relatedEntityId: payment.id,
  });
}

export async function notifyRefundIssued({ booking, refundAmount, fullRefund, reason }) {
  const amt = Number(refundAmount) || 0;
  const tail = fullRefund
    ? `Total dibayar booking ini sudah 0 — status booking jadi REFUNDED.`
    : `Sisa pembayaran booking masih ada — status tetap CANCELLED.`;
  const vars = {
    bookingNo: booking.bookingNo,
    refundAmountFormatted: fmtRp(amt),
    reason: reason ?? '-',
    tail,
  };
  const { subject, body } = renderTemplate('REFUND_ISSUED', 'WA', vars);
  await enqueueNotification({
    type: 'REFUND_ISSUED', channel: 'WA',
    recipientPhone: booking.jemaah?.phone,
    recipientUserId: booking.jemaah?.userId ?? booking.jemaahUserId ?? null,
    subject, body,
    payload: { bookingNo: booking.bookingNo, refundAmount: amt, fullRefund: !!fullRefund },
    relatedEntity: 'Booking', relatedEntityId: booking.id,
  });
}

/**
 * 5yy: fan-out an email to every ACTIVE admin (OWNER/SUPERADMIN/MANAJER_OPS)
 * when a gateway PaymentIntent settles (real money arrived). Lets ops know
 * without having to poll /admin/payment-intents.
 *
 * Like other admin fan-outs, deliberately omits `recipientUserId` — these
 * are admin-targeted, must never appear in any jemaah inbox (5ll invariant).
 */
export async function notifyPaymentSettledAdmin({ booking, payment, intent, paymentTypeRaw }) {
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return;

  const amt = Number(payment.amount?.toString?.() ?? payment.amount) || 0;
  const methodNote = paymentTypeRaw && paymentTypeRaw !== payment.method
    ? ` (gateway: ${paymentTypeRaw})`
    : '';
  const lunasNote = booking.status === 'LUNAS' ? '  ← LUNAS' : '';
  const vars = {
    bookingNo: booking.bookingNo,
    jemaahName: booking.jemaah?.fullName ?? '-',
    jemaahPhone: booking.jemaah?.phone ?? '-',
    paketTitle: booking.paket?.title ?? '-',
    kelas: booking.kelas,
    paxCount: booking.paxCount,
    amountFormatted: fmtRp(amt),
    method: payment.method,
    methodNote,
    orderId: intent?.orderId ?? '-',
    bookingStatus: booking.status,
    lunasNote,
    adminLink: `/admin/bookings/${booking.id}`,
  };
  const { subject, body } = renderTemplate('PAYMENT_SETTLED_ADMIN', 'EMAIL', vars);

  await Promise.all(admins.map((a) =>
    enqueueNotification({
      type: 'PAYMENT_SETTLED_ADMIN', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { bookingNo: booking.bookingNo, paymentId: payment.id, intentId: intent?.id, amount: amt },
      relatedEntity: 'PaymentIntent', relatedEntityId: intent?.id ?? null,
    }),
  ));
}

/**
 * Notify all ACTIVE admin users (OWNER/SUPERADMIN/MANAJER_OPS) when a jemaah
 * submits a cancel request (5ii). One EMAIL row per admin so each can be
 * tracked + retried independently in the queue.
 */
export async function notifyCancelRequested({ booking, reason, requestedByEmail }) {
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return;

  const paidAmt = Number(booking.paidAmount?.toString?.() ?? booking.paidAmount) || 0;
  const vars = {
    bookingNo: booking.bookingNo,
    jemaahName: booking.jemaah?.fullName ?? '-',
    jemaahPhone: booking.jemaah?.phone ?? '-',
    paketTitle: booking.paket?.title ?? '-',
    kelas: booking.kelas,
    paxCount: booking.paxCount,
    paidAmountFormatted: fmtRp(paidAmt),
    reason: reason ?? '-',
    requestedByEmail: requestedByEmail ?? '-',
    adminLink: `/admin/bookings/${booking.id}`,
  };
  const { subject, body } = renderTemplate('CANCEL_REQUESTED', 'EMAIL', vars);

  // Enqueue one per admin; failures handled per row by the dispatcher
  await Promise.all(admins.map((a) =>
    enqueueNotification({
      type: 'CANCEL_REQUESTED', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { bookingNo: booking.bookingNo, requestedByEmail },
      relatedEntity: 'Booking', relatedEntityId: booking.id,
    }),
  ));
}

/**
 * Crew SOS / emergency incident fan-out (admin-targeted). Triggered by
 * createIncident. EMAIL + WA both fire so admins are reachable on whichever
 * channel they're glued to. One row per (admin × channel) so each delivery
 * can be retried independently.
 *
 * Severity is implicit in `type`: SOS → CRITICAL, everything else → HIGH.
 * The template prefixes the subject with [CRITICAL] / [URGENT] so triage
 * order is obvious in the inbox.
 */
export async function notifyIncidentCreated({ incident, crew, paket }) {
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { email: true, phone: true },
  });
  if (admins.length === 0) return;

  const TYPE_LABEL = {
    SOS: 'SOS — Life-threatening',
    MEDICAL: 'Medical emergency',
    LOST_JEMAAH: 'Jemaah hilang / terpisah',
    SECURITY: 'Insiden keamanan',
    LOGISTICAL: 'Masalah logistik',
    OTHER: 'Insiden lain',
  };
  const severityTag = incident.type === 'SOS' ? 'CRITICAL' : 'URGENT';
  const vars = {
    typeLabel: TYPE_LABEL[incident.type] || incident.type,
    severityTag,
    crewName: crew?.fullName ?? '-',
    crewEmail: crew?.email ?? '-',
    crewPhoneNote: crew?.phone ? ` · ${crew.phone}` : '',
    paketTitle: paket?.title ?? '(tidak terkait paket)',
    locationLabel: incident.locationLabel ?? '-',
    createdAtFormatted: new Date(incident.createdAt).toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    messageBlock: incident.message ? incident.message : '(tidak ada pesan)',
    adminLink: `/admin/incidents/${incident.id}`,
  };

  // Email fan-out (one per admin with email)
  const email = renderTemplate('INCIDENT_REPORTED', 'EMAIL', vars);
  const wa = renderTemplate('INCIDENT_REPORTED', 'WA', vars);
  await Promise.all(admins.flatMap((a) => {
    const out = [];
    if (a.email) out.push(enqueueNotification({
      type: 'INCIDENT_REPORTED', channel: 'EMAIL',
      recipientEmail: a.email,
      subject: email.subject, body: email.body,
      payload: { incidentId: incident.id, type: incident.type, severityTag },
      relatedEntity: 'Incident', relatedEntityId: incident.id,
    }));
    if (a.phone) out.push(enqueueNotification({
      type: 'INCIDENT_REPORTED', channel: 'WA',
      recipientPhone: a.phone,
      subject: wa.subject ?? null, body: wa.body,
      payload: { incidentId: incident.id, type: incident.type, severityTag },
      relatedEntity: 'Incident', relatedEntityId: incident.id,
    }));
    return out;
  }));

  // Stage 17: Web Push fan-out — third layer alongside email + WA. Pops
  // in any admin browser that has the dashboard open, so they don't have
  // to refresh to notice an OPEN SOS. Fire-and-forget; failures inside
  // pushToAdmins are swallowed (its own try/catch + per-sub error counts).
  try {
    const { pushToAdmins } = await import('./webPush.js');
    await pushToAdmins({
      title: `[${severityTag}] ${TYPE_LABEL[incident.type] || incident.type}`,
      body: `${crew?.fullName || 'Crew'}: ${incident.message ? incident.message.slice(0, 120) : '(tidak ada pesan)'}`,
      url: `/admin/incidents/${incident.id}`,
      tag: `incident-${incident.id}`,        // dedupe across tabs
      requireInteraction: incident.type === 'SOS', // SOS sticks until user clicks
    });
  } catch (err) {
    console.warn('[notif] push fan-out failed:', err?.message || err);
  }
}

/**
 * Stage 30 — render one delta from `buildDigestWithComparison` into a
 * short suffix the email template embeds inline, e.g. `  · ▲ 12%`.
 *
 *   - empty (both windows zero) → '' (no suffix; the line stays clean)
 *   - flat (diff=0)             → ' · ='
 *   - up/down with pct          → ' · ▲ 12%' / ' · ▼ 27%'
 *   - up/down with pct=null     → ' · ▲ +3' (or ' · ▼ −2' for down)
 *
 * The leading separator (` · `) is included in the suffix so the template
 * stays string-literal stable — caller doesn't need to know if a delta is
 * present.
 */
function fmtEmailDelta(d) {
  if (!d || d.empty) return '';
  if (d.direction === 'flat') return '  ·  =';
  const arrow = d.direction === 'up' ? '▲' : '▼';
  if (d.pct === null) {
    const sign = d.diff >= 0 ? '+' : '−';
    const abs = Math.abs(d.diff).toLocaleString('id-ID');
    return `  ·  ${arrow} ${sign}${abs}`;
  }
  const sign = d.pct > 0 ? '+' : '';
  return `  ·  ${arrow} ${sign}${d.pct}%`;
}

/**
 * Stage 27 — daily activity digest fan-out to ACTIVE OWNER users.
 * Caller (cron / HTTP trigger) builds the digest via `buildDailyDigest()` or
 * `buildDigestWithComparison()` and passes the resulting payload here. One
 * EMAIL row per OWNER so each delivery can be retried independently.
 *
 * Limited to OWNER (not OWNER/SUPERADMIN/MANAJER_OPS like other admin fan-outs)
 * — this is a strategic "state of the business" summary, not an operational
 * alert. SUPERADMIN/MANAJER_OPS already have real-time access via /admin.
 *
 * Stage 30 — when `digest.deltas` is present (comparison helper), the email
 * body gets inline day-over-day delta suffixes per line. Otherwise the body
 * renders with empty delta placeholders, so the template stays the same.
 */
export async function notifyDailyDigest({ digest }) {
  const owners = await db.user.findMany({
    where: {
      role: 'OWNER',
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { id: true, email: true, fullName: true },
  });
  if (owners.length === 0) return { enqueued: 0, recipients: 0 };

  // Pull deltas (may be absent if caller passed a bare digest)
  const deltas = digest.deltas || {};

  // Stage 31 — needs-attention block. Caller can pass `needsAttention` alongside
  // the digest; absent → block renders empty so the template stays stable.
  const na = digest.needsAttention || null;
  let needsAttentionBlock = '';
  if (na && na.counts && na.counts.total > 0) {
    const lines = [];
    lines.push('\n— PERLU PERHATIAN');
    if (na.counts.openIncidents > 0) {
      lines.push(`Insiden OPEN > 24 jam: ${na.counts.openIncidents}`);
      na.openIncidents.slice(0, 3).forEach((i) => {
        lines.push(`  · ${i.ageHours}j · ${i.type} · ${i.createdBy?.fullName || '—'}${i.paket ? ' · ' + i.paket.title : ''}`);
      });
    }
    if (na.counts.cancelRequests > 0) {
      lines.push(`Cancel request > 24 jam: ${na.counts.cancelRequests}`);
      na.cancelRequests.slice(0, 3).forEach((b) => {
        lines.push(`  · ${b.ageHours}j · ${b.bookingNo} · ${b.jemaah?.fullName || '—'}`);
      });
    }
    if (na.counts.notifsFailed > 0) {
      lines.push(`Notif FAILED terminal: ${na.counts.notifsFailed}`);
      na.notifsFailed.slice(0, 3).forEach((n) => {
        lines.push(`  · ${n.ageHours}j · ${n.type} · ${n.channel}`);
      });
    }
    needsAttentionBlock = lines.join('\n') + '\n';
  }
  const dNewBookings      = fmtEmailDelta(deltas.newBookings);
  const dLunasBookings    = fmtEmailDelta(deltas.lunasBookings);
  const dLunasRevenue     = fmtEmailDelta(deltas.lunasRevenueIdr);
  const dNewJemaah        = fmtEmailDelta(deltas.newJemaah);
  const dNewLeads         = fmtEmailDelta(deltas.newLeads);
  const dPaymentsIn       = fmtEmailDelta(deltas.paymentsInIdr);
  const dRefundsOut       = fmtEmailDelta(deltas.refundsOutIdr);
  const dNetRevenue       = fmtEmailDelta(deltas.netRevenueIdr);
  const dKomisiEarned     = fmtEmailDelta(deltas.komisiEarnedIdr);
  const dKomisiPaid       = fmtEmailDelta(deltas.komisiPaidIdr);
  const dIncidentsCreated = fmtEmailDelta(deltas.incidentsCreated);

  let enqueued = 0;
  await Promise.all(owners.map(async (o) => {
    const vars = {
      ownerName: o.fullName || 'OWNER',
      label: digest.label,
      newBookings: digest.fmt.newBookings,
      lunasBookings: digest.fmt.lunasBookings,
      lunasRevenue: digest.fmt.lunasRevenue.replace('Rp ', ''),
      newJemaah: digest.fmt.newJemaah,
      newLeads: digest.fmt.newLeads,
      paymentsIn: digest.fmt.paymentsIn.replace('Rp ', ''),
      refundsOut: digest.fmt.refundsOut.replace('Rp ', ''),
      netRevenue: digest.fmt.netRevenue.replace('Rp ', ''),
      komisiEarned: digest.fmt.komisiEarned.replace('Rp ', ''),
      komisiPaid: digest.fmt.komisiPaid.replace('Rp ', ''),
      incidentsCreated: digest.fmt.incidentsCreated,
      incidentsOpen: digest.fmt.incidentsOpen,
      weekBookings: digest.week.bookings.toLocaleString('id-ID'),
      weekLunasBookings: digest.week.lunasBookings.toLocaleString('id-ID'),
      // Stage 30 — per-line trend suffixes ('  ·  ▲ 12%' or '')
      trendNewBookings: dNewBookings,
      trendLunasBookings: dLunasBookings,
      trendLunasRevenue: dLunasRevenue,
      trendNewJemaah: dNewJemaah,
      trendNewLeads: dNewLeads,
      trendPaymentsIn: dPaymentsIn,
      trendRefundsOut: dRefundsOut,
      trendNetRevenue: dNetRevenue,
      trendKomisiEarned: dKomisiEarned,
      trendKomisiPaid: dKomisiPaid,
      trendIncidentsCreated: dIncidentsCreated,
      // Stage 31 — single block embedding 0..N aged items per category;
      // empty string when nothing needs attention.
      needsAttentionBlock,
      adminLink: '/admin',
    };
    const { subject, body } = renderTemplate('DAILY_DIGEST_OWNER', 'EMAIL', vars);
    await enqueueNotification({
      type: 'DAILY_DIGEST_OWNER', channel: 'EMAIL',
      recipientEmail: o.email,
      subject, body,
      payload: { date: digest.date, counts: digest.counts, money: digest.money },
      // Admin-targeted: do NOT set recipientUserId — keeps row out of any
      // jemaah inbox (DAILY_DIGEST_OWNER recipients are owners, not jemaah,
      // but the convention is "admin fan-outs leave recipientUserId null").
    });
    enqueued += 1;
  }));

  return { enqueued, recipients: owners.length };
}

/**
 * Stage 33 — weekly summary email fan-out to ACTIVE OWNER users.
 * Mirror of notifyDailyDigest. Includes inline delta arrows per metric
 * comparing the past full week vs the week before.
 */
export async function notifyWeeklyDigest({ digest }) {
  const owners = await db.user.findMany({
    where: {
      role: 'OWNER',
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { id: true, email: true, fullName: true },
  });
  if (owners.length === 0) return { enqueued: 0, recipients: 0 };

  const d = digest.deltas || {};
  const dNewBookings       = fmtEmailDelta(d.newBookings);
  const dLunasBookings     = fmtEmailDelta(d.lunasBookings);
  const dCancelledBookings = fmtEmailDelta(d.cancelledBookings);
  const dLunasRevenue      = fmtEmailDelta(d.lunasRevenueIdr);
  const dNewJemaah         = fmtEmailDelta(d.newJemaah);
  const dNewLeads          = fmtEmailDelta(d.newLeads);
  const dPaymentsIn        = fmtEmailDelta(d.paymentsInIdr);
  const dRefundsOut        = fmtEmailDelta(d.refundsOutIdr);
  const dNetRevenue        = fmtEmailDelta(d.netRevenueIdr);
  const dKomisiEarned      = fmtEmailDelta(d.komisiEarnedIdr);
  const dKomisiPaid        = fmtEmailDelta(d.komisiPaidIdr);
  const dIncidentsCreated  = fmtEmailDelta(d.incidentsCreated);
  const dDocsVerified      = fmtEmailDelta(d.docsVerified);

  // Top-paket block — empty when nothing happened
  let topPaketBlock = '';
  if (digest.topPaket && digest.topPaket.length > 0) {
    const lines = ['\n— PAKET TERATAS (booking baru minggu ini)'];
    digest.topPaket.forEach((t, idx) => {
      const title = t.paket?.title || '(paket terhapus)';
      lines.push(`${idx + 1}. ${title} · ${t.count} booking`);
    });
    topPaketBlock = lines.join('\n') + '\n';
  }

  let enqueued = 0;
  await Promise.all(owners.map(async (o) => {
    const vars = {
      ownerName: o.fullName || 'OWNER',
      label: digest.label,
      newBookings: digest.fmt.newBookings,
      lunasBookings: digest.fmt.lunasBookings,
      cancelledBookings: digest.fmt.cancelledBookings,
      lunasRevenue: digest.fmt.lunasRevenue.replace('Rp ', ''),
      newJemaah: digest.fmt.newJemaah,
      newLeads: digest.fmt.newLeads,
      paymentsIn: digest.fmt.paymentsIn.replace('Rp ', ''),
      refundsOut: digest.fmt.refundsOut.replace('Rp ', ''),
      netRevenue: digest.fmt.netRevenue.replace('Rp ', ''),
      komisiEarned: digest.fmt.komisiEarned.replace('Rp ', ''),
      komisiPaid: digest.fmt.komisiPaid.replace('Rp ', ''),
      incidentsCreated: digest.fmt.incidentsCreated,
      docsVerified: digest.fmt.docsVerified,
      trendNewBookings: dNewBookings,
      trendLunasBookings: dLunasBookings,
      trendCancelledBookings: dCancelledBookings,
      trendLunasRevenue: dLunasRevenue,
      trendNewJemaah: dNewJemaah,
      trendNewLeads: dNewLeads,
      trendPaymentsIn: dPaymentsIn,
      trendRefundsOut: dRefundsOut,
      trendNetRevenue: dNetRevenue,
      trendKomisiEarned: dKomisiEarned,
      trendKomisiPaid: dKomisiPaid,
      trendIncidentsCreated: dIncidentsCreated,
      trendDocsVerified: dDocsVerified,
      topPaketBlock,
      adminLink: '/admin',
    };
    const { subject, body } = renderTemplate('WEEKLY_DIGEST_OWNER', 'EMAIL', vars);
    await enqueueNotification({
      type: 'WEEKLY_DIGEST_OWNER', channel: 'EMAIL',
      recipientEmail: o.email,
      subject, body,
      payload: { weekStart: digest.weekStart, counts: digest.counts, money: digest.money },
    });
    enqueued += 1;
  }));

  return { enqueued, recipients: owners.length };
}

/**
 * Stage 36 — per-agent weekly summary email. Caller iterates the agent
 * list and passes one built digest per agent. Each call enqueues exactly
 * one EMAIL row, indexed by recipientUserId so the agent can find it in
 * their own inbox (different convention from OWNER fan-outs — agents
 * benefit from inbox tracking; owners just need the email).
 */
export async function notifyAgentWeeklyDigest({ digest }) {
  if (!digest || !digest.agent?.user?.email) return { enqueued: 0 };

  const d = digest.deltas || {};
  const dNewBookings       = fmtEmailDelta(d.newBookings);
  const dLunasBookings     = fmtEmailDelta(d.lunasBookings);
  const dCancelledBookings = fmtEmailDelta(d.cancelledBookings);
  const dLeadsCreated      = fmtEmailDelta(d.leadsCreated);
  const dLeadsConverted    = fmtEmailDelta(d.leadsConverted);
  const dLeadsLost         = fmtEmailDelta(d.leadsLost);
  const dLunasRevenue      = fmtEmailDelta(d.lunasRevenueIdr);
  const dKomisiEarned      = fmtEmailDelta(d.komisiEarnedIdr);
  const dKomisiPaid        = fmtEmailDelta(d.komisiPaidIdr);

  let topPaketBlock = '';
  if (digest.topPaket && digest.topPaket.length > 0) {
    const lines = ['\n— PAKET TERATAS Anda minggu ini'];
    digest.topPaket.forEach((t, idx) => {
      const title = t.paket?.title || '(paket terhapus)';
      lines.push(`${idx + 1}. ${title} · ${t.count} booking`);
    });
    topPaketBlock = lines.join('\n') + '\n';
  }

  const vars = {
    agentName: digest.agent.user.fullName || digest.agent.displayName || 'Agen',
    label: digest.label,
    newBookings: digest.fmt.newBookings,
    lunasBookings: digest.fmt.lunasBookings,
    cancelledBookings: digest.fmt.cancelledBookings,
    leadsCreated: digest.fmt.leadsCreated,
    leadsConverted: digest.fmt.leadsConverted,
    leadsLost: digest.fmt.leadsLost,
    conversionPct: digest.fmt.conversionPct,
    lunasRevenue: digest.fmt.lunasRevenue.replace('Rp ', ''),
    komisiEarned: digest.fmt.komisiEarned.replace('Rp ', ''),
    komisiPaid: digest.fmt.komisiPaid.replace('Rp ', ''),
    trendNewBookings: dNewBookings,
    trendLunasBookings: dLunasBookings,
    trendCancelledBookings: dCancelledBookings,
    trendLeadsCreated: dLeadsCreated,
    trendLeadsConverted: dLeadsConverted,
    trendLeadsLost: dLeadsLost,
    trendLunasRevenue: dLunasRevenue,
    trendKomisiEarned: dKomisiEarned,
    trendKomisiPaid: dKomisiPaid,
    topPaketBlock,
    agenLink: '/agen',
  };
  const { subject, body } = renderTemplate('AGENT_WEEKLY_DIGEST', 'EMAIL', vars);
  await enqueueNotification({
    type: 'AGENT_WEEKLY_DIGEST', channel: 'EMAIL',
    recipientEmail: digest.agent.user.email,
    subject, body,
    payload: { weekStart: digest.weekStart, agentSlug: digest.agent.slug },
    relatedEntity: 'AgentProfile', relatedEntityId: digest.agent.id,
    // No recipientUserId — agent profiles aren't tied to JemaahProfile
    // (which is the recipient-inbox model). Email is the canonical channel.
  });
  return { enqueued: 1 };
}

/**
 * Stage 37 — payout reminder fan-out to ACTIVE OWNER/SUPERADMIN/MANAJER_OPS.
 * Skips silently when the candidates list is empty so an idle week doesn't
 * spam empty inboxes.
 */
export async function notifyPayoutReminder({ candidates }) {
  if (!candidates || candidates.rows.length === 0) {
    return { enqueued: 0, recipients: 0, skipped: true };
  }
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return { enqueued: 0, recipients: 0 };

  // Build the inline rows block — top 10 inline, the rest summarised
  // ("+ N agen lainnya...") so the email body stays scannable.
  const inlineRows = candidates.rows.slice(0, 10);
  const moreCount = Math.max(0, candidates.rows.length - inlineRows.length);
  const rowLines = inlineRows.map((r) => {
    const ageNote = r.ageDays != null ? ` · ${r.ageDays}h` : '';
    const name = r.agent?.displayName || r.agent?.slug || '(agen terhapus)';
    return `  · ${name} — ${r.totalFormatted} · ${r.count} komisi${ageNote}`;
  });
  if (moreCount > 0) rowLines.push(`  · + ${moreCount} agen lainnya…`);
  const rowsBlock = rowLines.join('\n');

  const vars = {
    candidateCount: candidates.counts.candidates.toString(),
    thresholdFormatted: 'Rp ' + Math.round(candidates.counts.thresholdIdr).toLocaleString('id-ID'),
    grandTotalFormatted: 'Rp ' + Math.round(candidates.counts.grandTotalIdr).toLocaleString('id-ID'),
    rowsBlock,
    payoutsLink: '/admin/payouts',
  };
  const { subject, body } = renderTemplate('PAYOUT_REMINDER_OWNER', 'EMAIL', vars);

  let enqueued = 0;
  await Promise.all(admins.map(async (a) => {
    await enqueueNotification({
      type: 'PAYOUT_REMINDER_OWNER', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { candidateCount: candidates.counts.candidates, grandTotalIdr: candidates.counts.grandTotalIdr },
    });
    enqueued += 1;
  }));
  return { enqueued, recipients: admins.length };
}

/**
 * Stage 42 — admin nudge fired when cancelBooking frees seats AND the
 * paket has WAITING waitlist entries. Body lists up to 5 candidates so
 * the admin can decide who to promote without leaving the inbox.
 *
 * Silent (no notif rows) when:
 *   - paket is full (kursiTerisi >= kursiTotal) — cancel didn't actually
 *     free a *usable* seat (rare race; defensive guard)
 *   - waitlist is empty (no one to promote — no signal worth sending)
 *
 * Multi-admin fan-out (one row per ACTIVE OWNER/SUPERADMIN/MANAJER_OPS)
 * so each delivery can be retried independently. KASIR excluded — the
 * promote action goes through the admin queue, not the cashier.
 */
export async function notifyWaitlistSlotFreed({ paketId, freedSeats, sourceBookingNo }) {
  // Re-read paket + waitlist atomically (relative to one query batch) —
  // the caller's transaction has already committed the seat change.
  const [paket, waiting] = await Promise.all([
    db.paket.findUnique({
      where: { id: paketId },
      select: { id: true, slug: true, title: true, kursiTotal: true, kursiTerisi: true },
    }),
    db.paketWaitlist.findMany({
      where: { paketId, status: 'WAITING' },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true, fullName: true, phone: true, createdAt: true, notes: true },
    }),
  ]);
  if (!paket || waiting.length === 0) return { enqueued: 0, skipped: true };

  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return { enqueued: 0 };

  const inline = waiting.slice(0, 5);
  const more = Math.max(0, waiting.length - inline.length);
  const rowLines = inline.map((w, idx) => {
    const ageDays = Math.floor((Date.now() - w.createdAt.getTime()) / 86_400_000);
    return `  ${idx + 1}. ${w.fullName} · ${w.phone} · sudah menunggu ${ageDays}h`;
  });
  if (more > 0) rowLines.push(`  · + ${more} jemaah lainnya…`);

  const vars = {
    paketTitle: paket.title,
    freedSeats: String(freedSeats),
    sourceBookingNo: sourceBookingNo || '—',
    waitingCount: String(waiting.length),
    rowsBlock: rowLines.join('\n'),
    waitlistLink: `/admin/paket/${paket.slug}/waitlist`,
    // Stage 44 — deep link auto-scrolls to + highlights the oldest WAITING
    // entry and pre-fills its promote form. Admin can also pick someone
    // else manually — this is a nudge, not a forced choice.
    waitlistLinkPromote: `/admin/paket/${paket.slug}/waitlist?promoteOldest=1`,
  };
  const { subject, body } = renderTemplate('WAITLIST_SLOT_FREED', 'EMAIL', vars);

  let enqueued = 0;
  await Promise.all(admins.map(async (a) => {
    await enqueueNotification({
      type: 'WAITLIST_SLOT_FREED', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { paketId, paketSlug: paket.slug, freedSeats, waitingCount: waiting.length },
      relatedEntity: 'Paket', relatedEntityId: paketId,
    });
    enqueued += 1;
  }));
  return { enqueued, recipients: admins.length };
}

/**
 * Stage 46 — per-agent stalled-leads digest fan-out. Caller iterates
 * agents and passes one digest per agent. Silent (no enqueue) when the
 * agent's stalled list is empty — quiet days shouldn't generate noise.
 */
export async function notifyStalledLeads({ agent, digest }) {
  if (!agent?.user?.email || !digest || digest.rows.length === 0) {
    return { enqueued: 0, skipped: true };
  }

  const inline = digest.rows.slice(0, 8);
  const more = Math.max(0, digest.rows.length - inline.length);
  const rowLines = inline.map((l, idx) => {
    const tag = l.status === 'WARM' ? '🔥' : '❄️';
    const source = l.source ? ` · src ${l.source}` : '';
    return `${idx + 1}. ${tag} ${l.fullName} · ${l.phone} · ${l.stalledDays}h tanpa update${source}`;
  });
  if (more > 0) rowLines.push(`  + ${more} lead lainnya…`);

  const vars = {
    agentName: agent.user.fullName || agent.displayName || 'Agen',
    staleDays: String(digest.staleDays),
    totalCount: String(digest.counts.total),
    warmCount: String(digest.counts.warm),
    coldCount: String(digest.counts.cold),
    rowsBlock: rowLines.join('\n'),
    agenLink: '/agen?tab=leads',
  };
  const { subject, body } = renderTemplate('AGENT_STALLED_LEADS', 'EMAIL', vars);
  await enqueueNotification({
    type: 'AGENT_STALLED_LEADS', channel: 'EMAIL',
    recipientEmail: agent.user.email,
    subject, body,
    payload: { agentSlug: agent.slug, totalCount: digest.counts.total },
    relatedEntity: 'AgentProfile', relatedEntityId: agent.id,
  });
  return { enqueued: 1 };
}

/**
 * Stage 53 — traffic anomaly fan-out. Silent when no anomalies (the
 * common case on healthy days). One EMAIL per ACTIVE OWNER/SUPERADMIN/
 * MANAJER_OPS, indexed by paket count in the payload.
 */
export async function notifyTrafficAnomalies({ anomalies }) {
  if (!anomalies || anomalies.rows.length === 0) {
    return { enqueued: 0, skipped: true };
  }
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return { enqueued: 0 };

  const inline = anomalies.rows.slice(0, 10);
  const more = Math.max(0, anomalies.rows.length - inline.length);
  const rowLines = inline.map((r, idx) =>
    `${idx + 1}. ${r.paket.title} · ${r.yesterday} visit (avg ${r.baselineMean}/hari) · turun ${r.dropPct}%`
  );
  if (more > 0) rowLines.push(`  · + ${more} paket lainnya…`);

  const vars = {
    paketCount: String(anomalies.rows.length),
    threshold: String(anomalies.thresholds.dropThresholdPct),
    minBaseline: String(anomalies.thresholds.minBaselineVisits),
    rowsBlock: rowLines.join('\n'),
    adminLink: '/admin',
  };
  const { subject, body } = renderTemplate('TRAFFIC_ANOMALY_OWNER', 'EMAIL', vars);

  let enqueued = 0;
  await Promise.all(admins.map(async (a) => {
    await enqueueNotification({
      type: 'TRAFFIC_ANOMALY_OWNER', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { paketCount: anomalies.rows.length, paketSlugs: anomalies.rows.map((r) => r.paket.slug) },
    });
    enqueued += 1;
  }));
  return { enqueued, recipients: admins.length };
}

/**
 * Stage 58 — landing slow alert. Called by send-landing-slow CLI when
 * the previous-day p95 latency crossed the budget. Silent when:
 *   - speed snapshot is null (no samples at all)
 *   - p95 is within budget
 *   - lowSample flag is true (don't fire on noisy data)
 *
 * Fan-out to ACTIVE OWNER/SUPERADMIN/MANAJER_OPS. KASIR excluded —
 * perf is an engineering escalation, not a cashier action.
 */
export async function notifyLandingSlow({ speed }) {
  if (!speed || !speed.overBudget || speed.lowSample) {
    return { enqueued: 0, skipped: true };
  }
  const admins = await db.user.findMany({
    where: {
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });
  if (admins.length === 0) return { enqueued: 0 };

  const slowLines = (speed.perPaket || []).slice(0, 5).map((p, idx) =>
    `${idx + 1}. ${p.paket.title} · p95 ${p.p95}ms · p50 ${p.p50}ms (${p.sample} sample)`
  );
  const perPaketBlock = slowLines.length > 0
    ? '\nPaket terlambat (worst 5 by p95):\n' + slowLines.join('\n') + '\n'
    : '';

  const vars = {
    p95: String(speed.p95),
    p50: String(speed.p50),
    p99: String(speed.p99),
    budget: String(speed.budgetMs),
    sample: String(speed.sample),
    windowDays: String(speed.window.days),
    perPaketBlock,
    adminLink: '/admin',
  };
  const { subject, body } = renderTemplate('LANDING_SLOW_OWNER', 'EMAIL', vars);

  let enqueued = 0;
  await Promise.all(admins.map(async (a) => {
    await enqueueNotification({
      type: 'LANDING_SLOW_OWNER', channel: 'EMAIL',
      recipientEmail: a.email,
      subject, body,
      payload: { p95: speed.p95, budgetMs: speed.budgetMs, sample: speed.sample },
    });
    enqueued += 1;
  }));
  return { enqueued, recipients: admins.length };
}

/**
 * Stage 65 — per-crew weekly digest fan-out. Caller iterates active
 * MUTHAWWIF users and passes one digest per crew. Silent when both the
 * last-week activity AND upcoming paket list are empty (idle weeks
 * shouldn't generate noise).
 */
export async function notifyCrewWeeklyDigest({ digest }) {
  if (!digest || !digest.user?.email) return { enqueued: 0, skipped: true };
  const noActivity = digest.counts.attendanceMarksCount === 0
    && digest.upcomingPaket.length === 0;
  if (noActivity) return { enqueued: 0, skipped: true };

  const upLines = digest.upcomingPaket.slice(0, 5).map((p) =>
    `  · ${p.title} · H-${p.daysUntilDeparture} (${p.durationDays}h trip) · ${p.kursiTerisi}/${p.kursiTotal} kursi`
  );
  const upcomingBlock = upLines.length > 0
    ? '\n— PAKET MENDATANG (30 hari ke depan)\n' + upLines.join('\n') + '\n'
    : '';

  // Stage 67 — per-line delta suffixes when previous week is present.
  // Uses the same `fmtEmailDelta` shape as the OWNER digests so the visual
  // style stays consistent across all weekly emails.
  const d = digest.deltas || {};
  const dMarks   = fmtEmailDelta(d.attendanceMarksCount);
  const dPresent = fmtEmailDelta(d.presentCount);
  const dAbsent  = fmtEmailDelta(d.absentCount);
  const dTouched = fmtEmailDelta(d.paketTouchedCount);

  const vars = {
    crewName: digest.user.fullName || 'Crew',
    label: digest.label,
    marksCount:        String(digest.counts.attendanceMarksCount),
    presentCount:      String(digest.counts.presentCount),
    absentCount:       String(digest.counts.absentCount),
    paketTouched:      String(digest.counts.paketTouchedCount),
    trendMarks:        dMarks,
    trendPresent:      dPresent,
    trendAbsent:       dAbsent,
    trendPaketTouched: dTouched,
    upcomingBlock,
    crewLink: '/crew',
  };
  const { subject, body } = renderTemplate('CREW_WEEKLY_DIGEST', 'EMAIL', vars);
  await enqueueNotification({
    type: 'CREW_WEEKLY_DIGEST', channel: 'EMAIL',
    recipientEmail: digest.user.email,
    recipientUserId: digest.user.id,
    subject, body,
    payload: { weekStart: digest.weekStart, crewId: digest.user.id },
  });
  return { enqueued: 1 };
}

/**
 * Stage 75 — first payment thanks. Fires once per booking after the first
 * PAID payment lands. Onboarding tone ("thanks + what's next"), distinct
 * from the neutral kuitansi notif (notifyPaymentReceived).
 *
 * Goes to whichever contact the booking has: linked jemaah user email
 * preferred, profile email as fallback. recipientUserId set when booking
 * is linked so the row appears in /saya/notifications with unread badge.
 * Anonymous bookings get the email but no inbox row.
 */
export async function notifyFirstPaymentThanks({ booking, payment }) {
  if (!booking) return { enqueued: 0, skipped: true };
  const recipientUserId = booking.jemaahUserId ?? booking.jemaah?.userId ?? null;
  const recipientEmail = booking.jemaah?.email || null;
  const recipientPhone = booking.jemaah?.phone || null;
  if (!recipientEmail) return { enqueued: 0, skipped: true };

  const amt = Number(payment.amount?.toString?.() ?? payment.amount) || 0;
  const vars = {
    jemaahName: booking.jemaah?.fullName ?? '-',
    bookingNo: booking.bookingNo,
    paketTitle: booking.paket?.title ?? '-',
    paymentAmount: fmtRp(amt).replace('Rp ', ''),
    method: payment.method,
    sayaLink: recipientUserId ? `/saya/bookings/${booking.id}` : '/',
  };
  const { subject, body } = renderTemplate('FIRST_PAYMENT_THANKS', 'EMAIL', vars);
  await enqueueNotification({
    type: 'FIRST_PAYMENT_THANKS', channel: 'EMAIL',
    recipientEmail, recipientPhone, recipientUserId,
    subject, body,
    payload: { bookingNo: booking.bookingNo, paymentId: payment.id },
    relatedEntity: 'Booking', relatedEntityId: booking.id,
  });
  return { enqueued: 1 };
}

/**
 * Stage 70 — fire a notif to the jemaah whose testimonial was just promoted
 * to PUBLISHED. Surfaces in the jemaah inbox (recipientUserId set) so the
 * unread badge picks it up too.
 */
export async function notifyTestimonialPublished({ user, testimonial, paket }) {
  if (!user?.email) return { enqueued: 0, skipped: true };
  const paketTitle = paket?.title || 'paket Anda';
  const vars = {
    jemaahName: user.fullName || 'Jamaah',
    paketTitle,
    paketLink: paket?.slug ? `/p/${paket.slug}` : '/',
    sayaLink: '/saya/notifications',
  };
  const { subject, body } = renderTemplate('TESTIMONIAL_PUBLISHED', 'EMAIL', vars);
  await enqueueNotification({
    type: 'TESTIMONIAL_PUBLISHED', channel: 'EMAIL',
    recipientEmail: user.email,
    recipientUserId: user.id,
    subject, body,
    payload: { testimonialId: testimonial.id, paketSlug: paket?.slug || null },
    relatedEntity: 'Testimonial', relatedEntityId: testimonial.id,
  });
  return { enqueued: 1 };
}

export async function notifyPayoutCreated({ payout, agent }) {
  const amt = Number(payout.amount?.toString?.() ?? payout.amount) || 0;
  const vars = {
    payoutNo: payout.payoutNo,
    amountFormatted: fmtRp(amt),
    method: payout.method,
    reference: payout.reference ?? '-',
  };
  const { subject, body } = renderTemplate('PAYOUT_CREATED', 'WA', vars);
  await enqueueNotification({
    type: 'PAYOUT_CREATED', channel: 'WA',
    recipientPhone: agent?.whatsapp,
    subject, body,
    payload: { payoutId: payout.id, payoutNo: payout.payoutNo, amount: amt },
    relatedEntity: 'KomisiPayout', relatedEntityId: payout.id,
  });
}
