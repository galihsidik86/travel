// Stage 240 — jemaah-submitted right-to-be-forgotten request (UU PDP
// article 8 — right to erasure). Admin reviews and decides; actual
// deletion is admin's manual action via the existing /admin/users
// delete flow. This service is the request trail.
//
// State machine: PENDING → APPROVED | DECLINED (both terminal).
//
// Submit rules:
//   - one PENDING per user at a time (re-submit while PENDING → 409)
//   - request reason required (min 10 chars — encourages context)
//   - prior APPROVED/DECLINED don't block new submission (jemaah's
//     situation may have changed)
//
// Admin decision rules:
//   - decision reason required (min 3 chars — durable trail)
//   - PENDING-only transitions (already-decided → 409)
//   - admin's actual user-delete is a SEPARATE action via /admin/users;
//     APPROVED here just says "we'll act on this".

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export async function submitDataDeletionRequest({ req, actor, userId, requestReason }) {
  if (!requestReason || requestReason.trim().length < 10) {
    throw new HttpError(400, 'Alasan permintaan minimal 10 karakter', 'REQUEST_REASON_REQUIRED');
  }
  const pending = await db.dataDeletionRequest.findFirst({
    where: { userId, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) {
    throw new HttpError(409, 'Permintaan sebelumnya masih diproses admin', 'ALREADY_PENDING');
  }
  const row = await db.dataDeletionRequest.create({
    data: {
      userId,
      requestReason: requestReason.trim(),
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'DataDeletionRequest', entityId: row.id,
    after: {
      userId,
      requestReason: requestReason.trim().slice(0, 200),
      status: 'PENDING',
    },
  });

  // Best-effort notify admins (OWNER+SUPERADMIN tier — privacy compliance
  // sits at the top of the hierarchy, MANAJER_OPS isn't included).
  try {
    const admins = await db.user.findMany({
      where: {
        role: { in: ['OWNER', 'SUPERADMIN'] },
        status: 'ACTIVE',
        deletedAt: null,
        email: { not: '' },
      },
      select: { email: true },
    });
    if (admins.length > 0) {
      const { enqueueNotification } = await import('./notifications.js');
      const subject = `[UU PDP] Permintaan hapus data — ${actor?.email || userId}`;
      const body = [
        `Permintaan hapus data masuk dari ${actor?.email || userId}.`,
        '',
        `Alasan: ${requestReason.trim()}`,
        '',
        `Tinjau di /admin/data-deletion-requests/${row.id}`,
      ].join('\n');
      await Promise.all(admins.map((a) =>
        enqueueNotification({
          type: 'GENERIC', channel: 'EMAIL',
          recipientEmail: a.email,
          subject, body,
          payload: { kind: 'data_deletion_request', requestId: row.id, userId },
          relatedEntity: 'DataDeletionRequest', relatedEntityId: row.id,
        }),
      ));
    }
  } catch (err) {
    console.warn('[dataDeletionRequest] admin notif failed:', err?.message || err);
  }

  return row;
}

export async function decideDataDeletionRequest({ req, actor, requestId, decision, decisionReason }) {
  if (decision !== 'APPROVED' && decision !== 'DECLINED') {
    throw new HttpError(400, 'Keputusan harus APPROVED atau DECLINED', 'BAD_DECISION');
  }
  if (!decisionReason || decisionReason.trim().length < 3) {
    throw new HttpError(400, 'Alasan keputusan minimal 3 karakter', 'DECISION_REASON_REQUIRED');
  }
  const before = await db.dataDeletionRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true, userId: true, status: true,
      user: { select: { email: true, fullName: true, jemaah: { select: { id: true } } } },
    },
  });
  if (!before) throw new HttpError(404, 'Permintaan tidak ditemukan', 'REQUEST_NOT_FOUND');
  if (before.status !== 'PENDING') {
    throw new HttpError(409, `Permintaan sudah ${before.status}`, 'ALREADY_DECIDED');
  }

  const now = new Date();
  const updated = await db.dataDeletionRequest.update({
    where: { id: requestId },
    data: {
      status: decision,
      decidedAt: now,
      decidedById: actor?.id || null,
      decidedByEmail: actor?.email || null,
      decisionReason: decisionReason.trim(),
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'DataDeletionRequest', entityId: requestId,
    before: { status: 'PENDING' },
    after: {
      status: decision,
      decisionReason: decisionReason.trim().slice(0, 200),
      decidedByEmail: actor?.email || null,
      targetUserId: before.userId,
    },
  });

  // Notify the jemaah of the outcome (best-effort)
  try {
    if (before.user?.email) {
      const { enqueueNotification } = await import('./notifications.js');
      const verdict = decision === 'APPROVED'
        ? 'DISETUJUI — admin akan menghapus akun Anda dalam waktu dekat.'
        : 'TIDAK DISETUJUI — silakan hubungi admin untuk diskusi lanjut.';
      const subject = `Permintaan hapus data Anda: ${decision === 'APPROVED' ? 'disetujui' : 'tidak disetujui'}`;
      const body = [
        `Halo ${before.user.fullName || 'Jemaah'},`,
        '',
        `Permintaan hapus data Anda telah ditinjau.`,
        '',
        `Hasil: ${verdict}`,
        '',
        `Alasan dari admin: ${decisionReason.trim()}`,
        '',
        '— Religio Pro',
      ].join('\n');
      await enqueueNotification({
        type: 'GENERIC', channel: 'EMAIL',
        recipientEmail: before.user.email,
        recipientUserId: before.userId,
        subject, body,
        payload: { kind: 'data_deletion_decision', requestId, decision },
        relatedEntity: 'DataDeletionRequest', relatedEntityId: requestId,
      });
    }
  } catch (err) {
    console.warn('[dataDeletionRequest] jemaah notif failed:', err?.message || err);
  }

  return updated;
}

export async function listMyDataDeletionRequests({ userId }) {
  return db.dataDeletionRequest.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: 20,
  });
}

export async function listPendingDataDeletionRequests({ limit = 50 } = {}) {
  return db.dataDeletionRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
    take: limit,
    include: {
      user: { select: { email: true, fullName: true, role: true } },
    },
  });
}
