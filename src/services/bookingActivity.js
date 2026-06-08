// Stage 98 — unified booking activity feed.
//
// The existing booking detail page renders six different lists (audit,
// payments, komisi, mentions, tasks, notifs) in separate panels. That's
// fine for editing, but reading the booking's story chronologically is
// hard — events are scattered across panels by entity type, not time.
//
// This service merges everything into one timeline sorted by `when`
// descending. Each row carries `{kind, label, when, by, url?, payload?}`:
//
//   kind    audit | payment | komisi | mention | task | notif | doc | attendance
//   label   human-readable one-liner ("Pembayaran Rp 5jt via TRANSFER")
//   by      actor display name + email
//   url     optional deep link for the row (e.g. payment.id → /admin/payments/X)
//   payload kind-specific data for badge styling
//
// Bounded at 150 rows by default — booking detail page is already busy;
// older history lives in /admin/audit anyway.
import { db } from '../lib/db.js';

const KIND_LABEL = {
  audit: 'AUDIT', payment: 'BAYAR', komisi: 'KOMISI',
  mention: 'MENTION', task: 'TASK', notif: 'NOTIF',
  doc: 'DOKUMEN', attendance: 'HADIR',
};

function actorLabel(email, role) {
  if (!email) return '—';
  return role ? `${email} (${role})` : email;
}

function fmtIdr(n) {
  return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
}

export async function getBookingActivityFeed(bookingId, { limit = 150 } = {}) {
  if (!bookingId) return { rows: [], counts: { total: 0 } };

  // Pull everything in parallel — small queries, narrow selects.
  const [audits, payments, komisi, mentions, tasks, notifs, docs, attendance] = await Promise.all([
    db.auditLog.findMany({
      where: { entity: 'Booking', entityId: bookingId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, actorEmail: true, actorRole: true, after: true, createdAt: true },
    }),
    db.payment.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, method: true, status: true, currency: true, createdAt: true, notes: true },
    }),
    db.komisi.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, status: true, createdAt: true, earnedAt: true },
    }),
    db.bookingMention.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, userEmail: true, mentionedByEmail: true, createdAt: true },
    }),
    db.task.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, body: true, status: true, dueAt: true, assigneeEmail: true,
        createdByEmail: true, completedByEmail: true,
        createdAt: true, completedAt: true,
      },
    }),
    db.notification.findMany({
      where: { relatedEntity: 'Booking', relatedEntityId: bookingId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, type: true, channel: true, status: true, recipientEmail: true, recipientPhone: true, createdAt: true, sentAt: true },
    }),
    // Doc transitions: we don't have a JemaahDocumentEvent table, so we
    // surface the latest verifiedAt / submittedAt from the linked jemaah
    // doc rows that this booking's jemaah owns.
    db.jemaahDocument.findMany({
      where: { jemaah: { bookings: { some: { id: bookingId } } } },
      orderBy: [{ verifiedAt: 'desc' }, { submittedAt: 'desc' }],
      take: 20,
      select: { id: true, type: true, status: true, submittedAt: true, verifiedAt: true, verifiedBy: { select: { email: true } } },
    }),
    db.attendanceMark.findMany({
      where: { bookingId },
      orderBy: { markedAt: 'desc' },
      take: 30,
      select: {
        id: true, present: true, markedAt: true,
        markedBy: { select: { email: true } },
        paketDay: { select: { dayNumber: true, title: true } },
      },
    }),
  ]);

  const rows = [];

  for (const a of audits) {
    rows.push({
      kind: 'audit', label: `Audit · ${a.action}`,
      when: a.createdAt,
      by: actorLabel(a.actorEmail, a.actorRole),
      payload: { action: a.action, after: a.after },
    });
  }

  for (const p of payments) {
    const sign = Number(p.amount.toString()) < 0 ? '−' : '';
    rows.push({
      kind: 'payment',
      label: `${p.status} · ${sign}${fmtIdr(Math.abs(Number(p.amount.toString())))} · ${p.method}`,
      when: p.createdAt,
      by: '—',
      payload: { status: p.status, amount: Number(p.amount.toString()) },
    });
  }

  for (const k of komisi) {
    rows.push({
      kind: 'komisi',
      label: `Komisi ${k.status} · ${fmtIdr(k.amount)}`,
      when: k.earnedAt || k.createdAt,
      by: '—',
      payload: { status: k.status, amount: Number(k.amount.toString()) },
    });
  }

  for (const m of mentions) {
    rows.push({
      kind: 'mention',
      label: `@${m.userEmail} di-mention`,
      when: m.createdAt,
      by: m.mentionedByEmail || '—',
    });
  }

  for (const t of tasks) {
    // Two rows per task: created + completed (if applicable)
    rows.push({
      kind: 'task',
      label: `Task → @${t.assigneeEmail}: ${t.body}`,
      when: t.createdAt,
      by: t.createdByEmail || '—',
      payload: { status: t.status, dueAt: t.dueAt },
    });
    if (t.completedAt) {
      rows.push({
        kind: 'task',
        label: `Task ${t.status}: ${t.body}`,
        when: t.completedAt,
        by: t.completedByEmail || '—',
        payload: { status: t.status, terminal: true },
      });
    }
  }

  for (const n of notifs) {
    rows.push({
      kind: 'notif',
      label: `${n.type} · ${n.channel} · ${n.status}`,
      when: n.sentAt || n.createdAt,
      by: n.recipientEmail || n.recipientPhone || '—',
      payload: { status: n.status, channel: n.channel },
    });
  }

  for (const d of docs) {
    // Show whichever stamp is most recent
    const when = d.verifiedAt || d.submittedAt;
    if (!when) continue;
    rows.push({
      kind: 'doc',
      label: `${d.type} → ${d.status}`,
      when,
      by: d.verifiedBy?.email || '—',
      payload: { status: d.status, type: d.type },
    });
  }

  for (const at of attendance) {
    rows.push({
      kind: 'attendance',
      label: `Day ${at.paketDay?.dayNumber || '?'} · ${at.present ? 'HADIR' : 'TIDAK HADIR'}${at.paketDay?.title ? ' · ' + at.paketDay.title : ''}`,
      when: at.markedAt,
      by: at.markedBy?.email || '—',
      payload: { present: at.present },
    });
  }

  // Sort newest first, cap at limit.
  rows.sort((a, z) => z.when.getTime() - a.when.getTime());
  const capped = rows.slice(0, limit);

  return {
    rows: capped,
    counts: { total: rows.length, shown: capped.length },
  };
}

export { KIND_LABEL };
