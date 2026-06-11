// Stage 204 — per-user audit activity timeline. Surfaces the last N
// audit entries where this user was the actor on /admin/users/:id/edit.
//
// Useful for the OWNER's "what has this kasir been doing?" question
// without leaving the user edit page. Read-only — never writes; the
// audit log is append-only.
//
// We cap at 50 by default; older history is reachable via
// `/admin/audit?actorEmail=<email>` which has the full pagination.

const DEFAULT_LIMIT = 50;

import { db } from '../lib/db.js';

export async function getUserActivityFeed({ userId, limit = DEFAULT_LIMIT } = {}) {
  if (!userId) return [];
  const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
  return db.auditLog.findMany({
    where: { actorUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: safeLimit,
    select: {
      id: true, action: true, entity: true, entityId: true,
      actorEmail: true, actorRole: true, ip: true,
      createdAt: true,
    },
  });
}

export { DEFAULT_LIMIT as USER_ACTIVITY_DEFAULT_LIMIT };
