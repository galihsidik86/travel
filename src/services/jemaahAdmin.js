import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const blank = (v) => (v === '' || v == null ? undefined : v);
const optStr = z.preprocess(blank, z.string().max(2000).optional());
const optDate = z.preprocess(
  (v) => (blank(v) === undefined ? null : new Date(String(v))),
  z.date().nullable().optional(),
);

const GENDERS = ['L', 'P'];

// 5jj: 3-state preprocessor for notif prefs. undefined = no change; presence = true; explicit false = false.
const notifPref = z.preprocess((v) => {
  if (v === undefined) return undefined;
  return v === 'on' || v === true || v === 'true';
}, z.boolean().optional());

export const JemaahSchema = z.object({
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Telepon minimal 8 karakter').max(30),
  email: z.preprocess(blank, z.string().email().max(190).optional()),
  nik: z.preprocess(blank, z.string().regex(/^\d{16}$/, 'NIK harus 16 digit').optional()),
  passportNo: optStr,
  passportExpiry: optDate,
  birthDate: optDate,
  gender: z.preprocess(blank, z.enum(GENDERS).optional()),
  address: optStr,
  emergencyContact: optStr,
  notes: optStr,
  notifEmail: notifPref,
  notifWa: notifPref,
});

/**
 * Passport expiry classification — relative to today.
 *   none     → no passport on file
 *   expired  → already past expiry
 *   urgent   → < 90 days remaining
 *   warning  → < 180 days remaining
 *   ok       → > 180 days
 *
 * Saudi visa rules require ≥ 6 months validity at departure — `warning` is
 * actionable, `urgent` blocks issuance.
 */
export function passportStatus(expiry) {
  if (!expiry) return 'none';
  const now = Date.now();
  const exp = new Date(expiry).getTime();
  if (exp < now) return 'expired';
  const daysLeft = (exp - now) / 86_400_000;
  if (daysLeft < 90) return 'urgent';
  if (daysLeft < 180) return 'warning';
  return 'ok';
}

export async function listJemaah({ search, expiringSoon } = {}) {
  const where = {};
  if (search) {
    where.OR = [
      { fullName: { contains: search } },
      { phone: { contains: search } },
      { nik: { contains: search } },
      { passportNo: { contains: search } },
    ];
  }
  if (expiringSoon) {
    const cutoff = new Date(Date.now() + 180 * 86_400_000);
    where.passportExpiry = { lte: cutoff };
  }
  const rows = await db.jemaahProfile.findMany({
    where,
    take: 200,
    orderBy: { fullName: 'asc' },
    include: { _count: { select: { bookings: true } } },
  });
  return rows.map((j) => ({ ...j, passportState: passportStatus(j.passportExpiry) }));
}

export async function getJemaahById(id) {
  const jemaah = await db.jemaahProfile.findUnique({
    where: { id },
    include: {
      bookings: {
        include: { paket: { select: { slug: true, title: true, departureDate: true } } },
        orderBy: { createdAt: 'desc' },
      },
      documents: { orderBy: { type: 'asc' } },
    },
  });
  if (!jemaah) return null;
  return { ...jemaah, passportState: passportStatus(jemaah.passportExpiry) };
}

export async function updateJemaah({ req, actor, jemaahId, input }) {
  const before = await db.jemaahProfile.findUnique({ where: { id: jemaahId } });
  if (!before) throw new HttpError(404, 'Jemaah tidak ditemukan', 'JEMAAH_NOT_FOUND');

  // NIK / passport uniqueness check (only if changed)
  if (input.nik && input.nik !== before.nik) {
    const clash = await db.jemaahProfile.findUnique({ where: { nik: input.nik } });
    if (clash) throw new HttpError(409, `NIK ${input.nik} sudah dipakai jemaah lain`, 'NIK_TAKEN');
  }
  if (input.passportNo && input.passportNo !== before.passportNo) {
    const clash = await db.jemaahProfile.findUnique({ where: { passportNo: input.passportNo } });
    if (clash) throw new HttpError(409, `Paspor ${input.passportNo} sudah dipakai jemaah lain`, 'PASSPORT_TAKEN');
  }

  const updated = await db.jemaahProfile.update({
    where: { id: jemaahId },
    data: {
      fullName: input.fullName,
      phone: input.phone,
      email: input.email ?? null,
      nik: input.nik ?? null,
      passportNo: input.passportNo ?? null,
      passportExpiry: input.passportExpiry ?? null,
      birthDate: input.birthDate ?? null,
      gender: input.gender ?? null,
      address: input.address ?? null,
      emergencyContact: input.emergencyContact ?? null,
      notes: input.notes ?? null,
      // Only update if explicitly sent (5jj — admin form may not include these)
      ...(input.notifEmail !== undefined ? { notifEmail: input.notifEmail } : {}),
      ...(input.notifWa !== undefined ? { notifWa: input.notifWa } : {}),
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'JemaahProfile', entityId: jemaahId,
    before: { fullName: before.fullName, nik: before.nik, passportNo: before.passportNo },
    after: { fullName: updated.fullName, nik: updated.nik, passportNo: updated.passportNo,
             changed: Object.keys(input) },
  });
  return updated;
}

export const META = { GENDERS };
