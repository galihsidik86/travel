// Stage 91 — extract `@user.email TODO ...` directives from booking notes,
// upsert as Task rows.
//
// Grammar (kept dead-simple on purpose; NLP is brittle):
//
//   @<email> TODO <body>[ by <YYYY-MM-DD>]
//
// - `TODO` is the literal marker; case-insensitive (TODO/todo/Todo all
//   work). It must immediately follow the mention (with optional
//   intervening whitespace).
// - Body runs until end-of-line OR the next `@email` mention OR the
//   pseudo-terminator `; ` (semicolon + space) — admin can chain TODOs.
// - Due date: optional trailing `by YYYY-MM-DD` (also `due `). The date
//   parses as local midnight; missing/malformed dates land as null.
//
// Idempotency: same (bookingId, assigneeEmail, body) — no duplicate
// task. Re-running save with the same TODO is a no-op; editing the
// body creates a new task and leaves the old one (admin can mark the
// stale one DONE or CANCELLED).
import { db } from '../lib/db.js';

const TODO_RE = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+TODO\s+([^\n;]+?)(?=\n|;|$)/gi;
const DUE_RE = /\b(?:by|due)\s+(\d{4}-\d{2}-\d{2})\b/i;

export function extractTodos(text) {
  if (!text) return [];
  const out = [];
  TODO_RE.lastIndex = 0;
  let m;
  while ((m = TODO_RE.exec(text)) !== null) {
    let body = m[2].trim();
    let dueAt = null;
    const dm = body.match(DUE_RE);
    if (dm) {
      const parsed = new Date(dm[1] + 'T00:00:00');
      if (!Number.isNaN(parsed.getTime())) dueAt = parsed;
      // Strip the `by YYYY-MM-DD` clause from the body so the stored
      // text matches what admin sees as the task title.
      body = body.replace(DUE_RE, '').replace(/\s{2,}/g, ' ').trim();
    }
    if (body.length === 0) continue;
    out.push({ assigneeEmail: m[1].toLowerCase(), body, dueAt });
  }
  return out;
}

/**
 * Diff incoming TODOs against existing OPEN tasks for the booking. Create
 * any new (assigneeEmail, body) pairs; do NOT close or mutate existing
 * rows — admin completes them via the inbox surface.
 *
 * Resolves assigneeId from User table when the email matches an ACTIVE
 * staff account; otherwise stores just the email.
 *
 * Best-effort: failure to write a row is logged but never aborts the
 * caller (the notes save itself is load-bearing).
 */
export async function upsertTodosForBooking({ bookingId, notes, actor }) {
  const todos = extractTodos(notes);
  if (todos.length === 0) return { created: 0, skipped: 0 };

  // Existing OPEN tasks for this booking — dedupe key is (email, body)
  const existing = await db.task.findMany({
    where: { bookingId, status: 'OPEN' },
    select: { assigneeEmail: true, body: true },
  });
  const haveKey = new Set(existing.map((t) => `${t.assigneeEmail}::${t.body}`));

  // Resolve emails → user ids in one batched lookup
  const distinctEmails = [...new Set(todos.map((t) => t.assigneeEmail))];
  const userRows = distinctEmails.length > 0
    ? await db.user.findMany({
        where: { email: { in: distinctEmails }, status: 'ACTIVE', deletedAt: null },
        select: { id: true, email: true },
      })
    : [];
  const userByEmail = new Map(userRows.map((u) => [u.email, u.id]));

  let created = 0, skipped = 0;
  for (const t of todos) {
    const key = `${t.assigneeEmail}::${t.body}`;
    if (haveKey.has(key)) { skipped += 1; continue; }
    try {
      await db.task.create({
        data: {
          bookingId,
          assigneeEmail: t.assigneeEmail,
          assigneeId: userByEmail.get(t.assigneeEmail) || null,
          body: t.body,
          dueAt: t.dueAt,
          createdById: actor?.id || null,
          createdByEmail: actor?.email || null,
        },
      });
      created += 1;
    } catch (err) {
      console.warn('[task] create failed:', err?.message || err);
    }
  }
  return { created, skipped };
}

export async function getMyOpenTasks({ assigneeEmail, limit = 20 } = {}) {
  if (!assigneeEmail) return { rows: [], totals: { open: 0, overdue: 0 } };

  const rows = await db.task.findMany({
    where: { assigneeEmail, status: 'OPEN' },
    take: limit,
    // Overdue + due-soon first (nulls last via two-step sort), then oldest.
    orderBy: [
      { dueAt: 'asc' },
      { createdAt: 'asc' },
    ],
    select: {
      id: true, body: true, dueAt: true, createdAt: true,
      createdByEmail: true,
      booking: {
        select: {
          id: true, bookingNo: true,
          jemaah: { select: { fullName: true } },
          paket: { select: { title: true } },
        },
      },
    },
  });

  const now = Date.now();
  const overdueCount = rows.filter((r) => r.dueAt && r.dueAt.getTime() < now).length;
  const totalOpen = await db.task.count({ where: { assigneeEmail, status: 'OPEN' } });

  return {
    rows,
    totals: { open: totalOpen, overdue: overdueCount, shown: rows.length },
  };
}

export async function completeTask({ id, actor }) {
  return db.task.update({
    where: { id },
    data: {
      status: 'DONE',
      completedAt: new Date(),
      completedById: actor?.id || null,
      completedByEmail: actor?.email || null,
    },
  });
}

export async function cancelTask({ id, actor }) {
  return db.task.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      completedById: actor?.id || null,
      completedByEmail: actor?.email || null,
    },
  });
}
