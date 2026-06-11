// Stage 192 — per-paket announcement banner. Admin posts a banner;
// renders on /saya/bookings/:id for jemaah on this paket.
//
// "Active" = publishedAt <= now AND (expiresAt == null OR expiresAt > now)
// — admin can schedule a future announcement, or set an expiry to
// auto-hide stale ones.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const AnnouncementSchema = z.object({
  title: z.string().min(3, 'Judul minimal 3 karakter').max(200),
  body: z.string().min(3, 'Isi minimal 3 karakter').max(5000),
  publishedAt: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().datetime({ offset: true }).optional(),
  ).optional(),
  expiresAt: z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.string().datetime({ offset: true }).nullable().optional(),
  ).optional(),
});

/**
 * List all announcements for a paket (admin view — includes scheduled
 * + expired ones). Sorted newest first.
 */
export async function listAnnouncements(paketId) {
  return db.paketAnnouncement.findMany({
    where: { paketId },
    orderBy: { publishedAt: 'desc' },
    include: {
      author: { select: { fullName: true, email: true } },
    },
  });
}

/**
 * Active announcements for a paket — what jemaah sees on
 * /saya/bookings/:id. Filtered to `publishedAt <= now AND
 * (expiresAt == null OR expiresAt > now)`.
 */
export async function listActiveAnnouncements({ paketId, now = new Date() } = {}) {
  return db.paketAnnouncement.findMany({
    where: {
      paketId,
      publishedAt: { lte: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: { publishedAt: 'desc' },
  });
}

export async function createAnnouncement({ req, actor, paketId, input }) {
  const data = AnnouncementSchema.parse(input);
  const paket = await db.paket.findUnique({
    where: { id: paketId }, select: { id: true, slug: true, title: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  const row = await db.paketAnnouncement.create({
    data: {
      paketId,
      title: data.title, body: data.body,
      publishedAt: data.publishedAt ? new Date(data.publishedAt) : undefined,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      authorId: actor?.id || null,
    },
  });
  await audit({
    req, actor, action: 'CREATE',
    entity: 'PaketAnnouncement', entityId: row.id,
    after: {
      paketSlug: paket.slug, title: row.title,
      publishedAt: row.publishedAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    },
  });

  // Stage 193 — fan out push notif to every active jemaah on this paket
  // who has the /saya PWA installed. Fire-and-forget; failures logged
  // but don't abort the create transaction (the announcement is the
  // load-bearing artifact, push is additive).
  if (row.publishedAt <= new Date()) {
    pushAnnouncementToJemaah({ paket, announcement: row }).catch((err) => {
      console.warn('[announcement-push] fan-out failed:', err?.message || err);
    });
  }

  return row;
}

/**
 * Stage 193 — fan-out helper. Loads every active jemaah on this paket
 * (via Booking → User), pushes the announcement payload. Best-effort.
 * Silent when nobody has the PWA installed.
 */
async function pushAnnouncementToJemaah({ paket, announcement }) {
  // Pull distinct jemaah userIds from active bookings on this paket
  const bookings = await db.booking.findMany({
    where: {
      paketId: paket.id,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      jemaahUserId: { not: null },
    },
    select: { jemaahUserId: true },
  });
  const userIds = [...new Set(bookings.map((b) => b.jemaahUserId).filter(Boolean))];
  if (userIds.length === 0) return { recipients: 0, delivered: 0 };
  const { pushToUser } = await import('./webPush.js');
  const bodyPreview = announcement.body.length > 140
    ? announcement.body.slice(0, 140) + '…'
    : announcement.body;
  const payload = {
    title: `📢 ${announcement.title}`,
    body: bodyPreview,
    tag: `paket-announcement-${announcement.id}`,
    url: `/saya`,
    data: {
      kind: 'paket_announcement',
      paketSlug: paket.slug,
      announcementId: announcement.id,
    },
  };
  let delivered = 0, recipients = 0;
  for (const uid of userIds) {
    const r = await pushToUser(uid, payload);
    recipients += 1;
    delivered += r?.delivered || 0;
  }
  return { recipients, delivered };
}

export async function updateAnnouncement({ req, actor, id, input }) {
  const before = await db.paketAnnouncement.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'Announcement tidak ditemukan', 'ANNOUNCEMENT_NOT_FOUND');
  const data = AnnouncementSchema.parse(input);
  const row = await db.paketAnnouncement.update({
    where: { id },
    data: {
      title: data.title, body: data.body,
      publishedAt: data.publishedAt ? new Date(data.publishedAt) : undefined,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });
  await audit({
    req, actor, action: 'UPDATE',
    entity: 'PaketAnnouncement', entityId: id,
    before: { title: before.title, expiresAt: before.expiresAt?.toISOString() ?? null },
    after:  { title: row.title,    expiresAt: row.expiresAt?.toISOString() ?? null },
  });
  return row;
}

export async function deleteAnnouncement({ req, actor, id }) {
  const before = await db.paketAnnouncement.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'Announcement tidak ditemukan', 'ANNOUNCEMENT_NOT_FOUND');
  await db.paketAnnouncement.delete({ where: { id } });
  await audit({
    req, actor, action: 'DELETE',
    entity: 'PaketAnnouncement', entityId: id,
    before: { paketSlug: before.paket?.slug, title: before.title },
  });
  return { id, paketId: before.paketId };
}
