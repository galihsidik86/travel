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
    where: { id: paketId }, select: { id: true, slug: true },
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
  return row;
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
