import { z } from 'zod';
import { db } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES', 'AGEN', 'MUTHAWWIF', 'JEMAAH'];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION'];
const STAFF_ROLES = new Set(['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES']);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const blank = (v) => (v === '' || v == null ? undefined : v);
const optStr = z.preprocess(blank, z.string().max(2000).optional());

export const UserBaseSchema = z.object({
  email: z.string().email('Email tidak valid').max(190).toLowerCase(),
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: optStr,
  role: z.enum(ROLES),
  status: z.enum(STATUSES).default('ACTIVE'),
});

// Komisi rate override for AGEN profiles (5v) — input as %, stored as decimal fraction.
// Distinguishes 3 states:
//   undefined → field not sent at all → don't change DB
//   null      → empty string sent → explicit clear (set DB to null)
//   number    → set DB to (value / 100) as Decimal(5,4)
const komisiOverridePct = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;     // field not in body
    if (v === '' || v === null) return null;   // explicit clear
    return Number(v);
  },
  z.union([z.number().min(0, 'Min 0%').max(50, 'Max 50% — sanity cap'), z.null()]).optional(),
);

export const CreateUserSchema = UserBaseSchema.extend({
  password: z.string().min(8, 'Password minimal 8 karakter').max(200),
  // Profile fields (per role) — validated per-role downstream, all optional in schema
  slug: optStr,
  displayName: optStr,
  whatsapp: optStr,
  bio: optStr,
  tier: optStr,
  komisiRateOverridePct: komisiOverridePct,
  department: optStr,
  position: optStr,
  languages: optStr,
  experience: z.preprocess((v) => (blank(v) === undefined ? undefined : Number(v)), z.number().int().min(0).max(80).optional()),
  // Stage 73 — crew public profile fields
  crewSlug: optStr,
  crewTitlePrefix: optStr,
  crewBio: optStr,
  crewPhotoUrl: optStr,
  // Stage 74 — agent public profile photo + IG
  agentPhotoUrl: optStr,
  igHandle: optStr,
});

export const UpdateUserSchema = UserBaseSchema.extend({
  // Profile fields optional for update too
  slug: optStr,
  displayName: optStr,
  whatsapp: optStr,
  bio: optStr,
  tier: optStr,
  komisiRateOverridePct: komisiOverridePct,
  department: optStr,
  position: optStr,
  languages: optStr,
  experience: z.preprocess((v) => (blank(v) === undefined ? undefined : Number(v)), z.number().int().min(0).max(80).optional()),
  crewSlug: optStr,
  crewTitlePrefix: optStr,
  crewBio: optStr,
  crewPhotoUrl: optStr,
  agentPhotoUrl: optStr,
  igHandle: optStr,
});

export const PasswordSchema = z.object({
  password: z.string().min(8, 'Password minimal 8 karakter').max(200),
});

/**
 * Anti-escalation guard. SUPERADMIN can manage anyone EXCEPT OWNER.
 * OWNER can manage anyone.
 */
function guardEscalation(actor, targetRole) {
  if (actor.role === 'OWNER') return;
  if (actor.role === 'SUPERADMIN' && targetRole !== 'OWNER') return;
  throw new HttpError(403,
    `Peran ${actor.role} tidak boleh membuat/mengubah user dengan peran ${targetRole}`,
    'ROLE_ESCALATION_BLOCKED');
}

/**
 * @param {object} opts
 * @param {'ACTIVE'|'DELETED'|'ALL'} [opts.deleted='ACTIVE']  S104 deleted-account filter:
 *   ACTIVE (default)  → `deletedAt: null`
 *   DELETED           → `deletedAt: { not: null }`
 *   ALL               → no deletedAt filter
 */
// Stage 188 — known AGEN tier strings. Kept loose (admin can freeform
// the tier in /admin/users/:id/edit so future tiers stay supported);
// the filter validates against any non-empty value but the dropdown
// surfaces the canonical four.
const AGENT_TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];

export async function listUsers({ search, role, status, deleted = 'ACTIVE', sortBy = 'default', tier = 'ALL' } = {}) {
  const where = {};
  if (deleted === 'ACTIVE') where.deletedAt = null;
  else if (deleted === 'DELETED') where.deletedAt = { not: null };
  // 'ALL' → no filter
  if (role && role !== 'ALL') where.role = role;
  if (status && status !== 'ALL') where.status = status;
  if (search) {
    where.OR = [
      { email: { contains: search } },
      { fullName: { contains: search } },
    ];
  }
  // Stage 188 — AGEN tier filter. Only meaningful when role is AGEN
  // (others don't have an agent profile). Tier value is loose-match
  // case-insensitive uppercase so a stored "gold" matches dropdown "GOLD".
  if (tier && tier !== 'ALL') {
    const t = String(tier).trim().toUpperCase();
    if (t) {
      where.agent = { tier: t };
      // Implicit AGEN role narrow — without it the query would only match
      // non-AGEN users who somehow have an AgentProfile, which doesn't
      // happen, so it's safe to force the role too for clarity.
      where.role = 'AGEN';
    }
  }
  // Stage 177 — sortBy=lastLogin orders by lastLoginAt asc (NULL last
  // = "never logged in" lands at the very bottom — Prisma puts NULL
  // first by default on asc, but operators usually want "never" to be
  // the most-alarming entry, so we apply `nulls: 'last'`).
  let orderBy;
  if (sortBy === 'lastLogin') {
    orderBy = [{ lastLoginAt: { sort: 'asc', nulls: 'last' } }, { fullName: 'asc' }];
  } else {
    orderBy = [{ role: 'asc' }, { fullName: 'asc' }];
  }
  return db.user.findMany({
    where,
    take: 200,
    orderBy,
    include: {
      agent: { select: { slug: true, tier: true, isVerified: true, komisiRateOverride: true, photoUrl: true, igHandle: true, dormantSince: true } },
      staff: { select: { department: true, position: true } },
      crew:  { select: { languages: true, experience: true, slug: true, titlePrefix: true, bio: true, photoUrl: true } },
    },
  });
}

export { AGENT_TIERS };

/**
 * Stage 104 — undo a soft-delete. Sets `deletedAt = null`. Records an
 * AUDIT row so it's clear who restored the account + when. Idempotent on
 * already-active rows (no-op + no audit).
 */
export async function restoreUser({ req, actor, userId }) {
  const before = await db.user.findUnique({ where: { id: userId } });
  if (!before) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  if (!before.deletedAt) return before;  // already active, no-op
  const updated = await db.user.update({
    where: { id: userId },
    data: { deletedAt: null },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'User', entityId: userId,
    before: { deletedAt: before.deletedAt },
    after: { deletedAt: null, restored: true, email: updated.email },
  });
  return updated;
}

/**
 * Stage 82 — mention autocomplete on the booking-notes textarea.
 *
 * Returns up to 10 ACTIVE staff users matching `q` substring (email OR
 * fullName). Restricted to staff roles (OWNER/SUPERADMIN/MANAJER_OPS/
 * KASIR/SALES) — the @-mention surface is staff shorthand, never a
 * customer/jemaah ping. AGEN/MUTHAWWIF excluded too — they don't read
 * the admin booking detail page.
 *
 * Empty / 1-char `q` returns []: protects against accidental full-table
 * scans from the autocomplete debounce hammering on backspace.
 */
export async function searchStaffForMention({ q } = {}) {
  const term = (q || '').trim();
  if (term.length < 2) return [];
  const users = await db.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES'] },
      OR: [
        { email: { contains: term } },
        { fullName: { contains: term } },
      ],
    },
    take: 10,
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: { id: true, email: true, fullName: true, role: true },
  });
  return users;
}

export async function getUserById(userId) {
  return db.user.findUnique({
    where: { id: userId },
    include: { agent: true, staff: true, crew: true, jemaah: true },
  });
}

async function createProfileFor(tx, user, input) {
  const role = user.role;
  if (role === 'AGEN') {
    if (!input.slug || !SLUG_RE.test(input.slug)) {
      throw new HttpError(400, 'Slug agen wajib (format: huruf kecil + strip)', 'BAD_AGENT_SLUG');
    }
    const clash = await tx.agentProfile.findUnique({ where: { slug: input.slug } });
    if (clash) throw new HttpError(409, `Slug "${input.slug}" sudah dipakai agen lain`, 'AGENT_SLUG_TAKEN');
    await tx.agentProfile.create({
      data: {
        userId: user.id,
        slug: input.slug,
        displayName: input.displayName || user.fullName,
        whatsapp: input.whatsapp || user.phone || '',
        bio: input.bio || null,
        tier: input.tier || null,
        komisiRateOverride: input.komisiRateOverridePct != null
          ? (input.komisiRateOverridePct / 100).toFixed(4)
          : null,
        // Stage 74 — public profile fields for /a/:slug
        photoUrl: input.agentPhotoUrl?.trim() || null,
        igHandle: input.igHandle?.trim().replace(/^@/, '') || null,
      },
    });
  } else if (STAFF_ROLES.has(role)) {
    await tx.staffProfile.create({
      data: {
        userId: user.id,
        department: input.department || null,
        position: input.position || null,
      },
    });
  } else if (role === 'MUTHAWWIF') {
    await tx.crewProfile.create({
      data: {
        userId: user.id,
        languages: input.languages || null,
        experience: input.experience ?? null,
        // Stage 73 — public profile fields. Slug must be unique globally;
        // empty strings normalised to null so the @unique index doesn't
        // conflict on the next muthawwif created without a slug.
        slug:        input.crewSlug?.trim().toLowerCase() || null,
        titlePrefix: input.crewTitlePrefix?.trim() || null,
        bio:         input.crewBio?.trim() || null,
        photoUrl:    input.crewPhotoUrl?.trim() || null,
      },
    });
  } else if (role === 'JEMAAH') {
    await tx.jemaahProfile.create({
      data: {
        userId: user.id,
        fullName: user.fullName,
        phone: user.phone || '',
      },
    });
  }
}

export async function createUser({ req, actor, input }) {
  guardEscalation(actor, input.role);

  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) throw new HttpError(409, 'Email sudah terdaftar', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);

  const user = await db.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: input.role,
        status: input.status,
        fullName: input.fullName,
        phone: input.phone ?? null,
      },
    });
    await createProfileFor(tx, u, input);
    return u;
  });

  await audit({
    req, actor,
    action: 'CREATE', entity: 'User', entityId: user.id,
    after: { email: user.email, role: user.role, fullName: user.fullName, status: user.status },
  });
  return user;
}

export async function updateUser({ req, actor, userId, input }) {
  const before = await db.user.findUnique({
    where: { id: userId },
    include: { agent: true, staff: true, crew: true },
  });
  if (!before || before.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');

  // Anti-escalation: both source AND target roles must be allowed
  guardEscalation(actor, before.role);
  guardEscalation(actor, input.role);

  // Email change → check uniqueness
  if (input.email !== before.email) {
    const clash = await db.user.findUnique({ where: { email: input.email } });
    if (clash) throw new HttpError(409, 'Email sudah dipakai user lain', 'EMAIL_TAKEN');
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: userId },
      data: {
        email: input.email,
        fullName: input.fullName,
        phone: input.phone ?? null,
        role: input.role,
        status: input.status,
      },
    });

    // Sync linked profile (only for the CURRENT role).
    // Role change: leave old profile intact (audit trail), create new one if missing.
    if (u.role === 'AGEN') {
      const existingAgent = await tx.agentProfile.findUnique({ where: { userId: u.id } });
      if (existingAgent) {
        // 3-state semantics: undefined = no change, null = clear, number = set
        const overridePatch = input.komisiRateOverridePct === undefined
          ? {}
          : { komisiRateOverride: input.komisiRateOverridePct === null
              ? null
              : (input.komisiRateOverridePct / 100).toFixed(4) };
        // Stage 74 — normalise empty strings to null + strip leading @ on IG
        const normPub = (v) => (v == null ? null : (typeof v === 'string' ? (v.trim() || null) : v));
        await tx.agentProfile.update({
          where: { userId: u.id },
          data: {
            slug: input.slug || existingAgent.slug,
            displayName: input.displayName || u.fullName,
            whatsapp: input.whatsapp || existingAgent.whatsapp,
            bio: input.bio ?? existingAgent.bio,
            tier: input.tier ?? existingAgent.tier,
            photoUrl: input.agentPhotoUrl !== undefined ? normPub(input.agentPhotoUrl) : existingAgent.photoUrl,
            igHandle: input.igHandle !== undefined
              ? (normPub(input.igHandle)?.replace(/^@/, '') ?? null)
              : existingAgent.igHandle,
            ...overridePatch,
          },
        });
      } else {
        await createProfileFor(tx, u, input);
      }
    } else if (STAFF_ROLES.has(u.role)) {
      const existingStaff = await tx.staffProfile.findUnique({ where: { userId: u.id } });
      if (existingStaff) {
        await tx.staffProfile.update({
          where: { userId: u.id },
          data: {
            department: input.department ?? existingStaff.department,
            position: input.position ?? existingStaff.position,
          },
        });
      } else {
        await createProfileFor(tx, u, input);
      }
    } else if (u.role === 'MUTHAWWIF') {
      const existingCrew = await tx.crewProfile.findUnique({ where: { userId: u.id } });
      if (existingCrew) {
        // Stage 73 — normalise empty-string crew fields to null (form
        // posts blank inputs as "" which we want to mean "clear" so the
        // @unique on slug doesn't keep stale data).
        const norm = (v) => (v == null ? null : (typeof v === 'string' ? (v.trim() || null) : v));
        await tx.crewProfile.update({
          where: { userId: u.id },
          data: {
            languages: input.languages ?? existingCrew.languages,
            experience: input.experience ?? existingCrew.experience,
            slug:        input.crewSlug !== undefined ? norm(input.crewSlug)?.toLowerCase() : existingCrew.slug,
            titlePrefix: input.crewTitlePrefix !== undefined ? norm(input.crewTitlePrefix) : existingCrew.titlePrefix,
            bio:         input.crewBio !== undefined ? norm(input.crewBio) : existingCrew.bio,
            photoUrl:    input.crewPhotoUrl !== undefined ? norm(input.crewPhotoUrl) : existingCrew.photoUrl,
          },
        });
      } else {
        await createProfileFor(tx, u, input);
      }
    }
    return u;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'User', entityId: updated.id,
    before: { email: before.email, role: before.role, status: before.status, fullName: before.fullName },
    after: { email: updated.email, role: updated.role, status: updated.status, fullName: updated.fullName },
  });
  return updated;
}

export async function setPassword({ req, actor, userId, password }) {
  const before = await db.user.findUnique({ where: { id: userId } });
  if (!before || before.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  guardEscalation(actor, before.role);

  const passwordHash = await hashPassword(password);
  await db.user.update({ where: { id: userId }, data: { passwordHash } });
  await audit({
    req, actor,
    action: 'PASSWORD_CHANGE', entity: 'User', entityId: userId,
    after: { resetByAdmin: true, actorEmail: actor.email },
  });
}

export async function suspendUser({ req, actor, userId }) {
  const before = await db.user.findUnique({ where: { id: userId } });
  if (!before || before.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  guardEscalation(actor, before.role);
  if (before.id === actor.id) {
    throw new HttpError(409, 'Tidak bisa men-suspend diri sendiri', 'SELF_SUSPEND_BLOCKED');
  }
  const updated = await db.user.update({
    where: { id: userId }, data: { status: 'SUSPENDED' },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'User', entityId: userId,
    before: { status: before.status }, after: { status: 'SUSPENDED' },
  });
  return updated;
}

export async function reactivateUser({ req, actor, userId }) {
  const before = await db.user.findUnique({ where: { id: userId } });
  if (!before || before.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  guardEscalation(actor, before.role);
  const updated = await db.user.update({
    where: { id: userId }, data: { status: 'ACTIVE' },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'User', entityId: userId,
    before: { status: before.status }, after: { status: 'ACTIVE' },
  });
  return updated;
}

export const META = { ROLES, STATUSES, STAFF_ROLES };
