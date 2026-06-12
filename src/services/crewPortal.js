// 5oo: muthawwif portal data layer.
//
// Crew see a slim, read-only view of their assigned paket and the jemaah
// manifest. No write capability — money/doc edits go through other roles.
// Assignment is via PaketCrew M2M; admin manages from /admin/paket/:slug/edit.
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { pillsForJemaah } from './jemaahDocs.js';

const ACTIVE_PAKET_STATUSES = ['ACTIVE', 'DRAFT', 'CLOSED']; // exclude ARCHIVED

/**
 * Paket assigned to a crew user. Filters out ARCHIVED + soft-deleted.
 * Ordered by departureDate asc so the next trip is on top.
 */
export async function listAssignedPaket(userId) {
  const assignments = await db.paketCrew.findMany({
    where: {
      userId,
      paket: {
        status: { in: ACTIVE_PAKET_STATUSES },
        deletedAt: null,
      },
    },
    include: {
      paket: {
        select: {
          id: true, slug: true, title: true, subtitle: true,
          departureDate: true, returnDate: true, durationDays: true,
          kursiTotal: true, kursiTerisi: true,
          status: true,
          _count: { select: { bookings: true } },
        },
      },
    },
    orderBy: { paket: { departureDate: 'asc' } },
  });
  return assignments.map((a) => a.paket);
}

/**
 * Read-only manifest of a paket for a crew user. Returns null if the user
 * isn't assigned to this paket (so the route can 404 without leaking).
 *
 * Manifest excludes money fields (totalAmount/paidAmount/payments) — crew
 * shouldn't see balances. Includes: bookingNo, jemaah identity + phone,
 * kelas, paxCount, doc completion pills, room assignment, status.
 */
export async function getAssignedManifest({ userId, slug }) {
  const assignment = await db.paketCrew.findFirst({
    where: { userId, paket: { slug, deletedAt: null } },
    select: { paketId: true },
  });
  if (!assignment) return null;

  const paket = await db.paket.findUnique({
    where: { id: assignment.paketId },
    select: {
      id: true, slug: true, title: true,
      departureDate: true, returnDate: true, durationDays: true,
      kursiTotal: true, kursiTerisi: true,
      // Stage 222 — WA group invite for trip coordination
      waGroupUrl: true,
      bookings: {
        where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        orderBy: [{ kelas: 'asc' }, { createdAt: 'asc' }],
        select: {
          // Stage 231 — booking tags (S226) on crew manifest so muthawwif
          // sees VIP/LANSIA/etc. at a glance.
          id: true, bookingNo: true, kelas: true, paxCount: true, status: true, tags: true,
          jemaah: {
            select: {
              id: true, fullName: true, phone: true,
              passportNo: true, passportExpiry: true,
              emergencyContact: true,
              // Stage 210 — dietary visible on crew manifest so muthawwif
              // can flag special meals to hotel / restaurant on arrival.
              dietary: true, dietaryNotes: true,
              documents: { select: { type: true, status: true } },
            },
          },
          room: { select: { roomNo: true, floor: true, wing: true } },
          // Stage 228 — pickup choice visible on crew manifest so
          // muthawwif knows who's meeting where at the pre-departure
          // bus run. Same money-stripped + non-leaking pattern as the
          // rest of the crew view. **pickupId scalar required** so the
          // summary Map can key per-pickup (the relation alone isn't enough).
          pickupId: true,
          pickup: { select: { id: true, label: true, departTime: true } },
        },
      },
    },
  });
  if (!paket) return null;

  // Enrich with doc pills (5s utility) so crew can scan readiness at a glance.
  const enriched = paket.bookings.map((b) => ({
    ...b,
    docPills: pillsForJemaah(b.jemaah.documents),
  }));

  // Stage 214 — dietary roll-up for the in-portal brief. Mirrors S211
  // CSV shape so crew see the same numbers as the email. REGULAR
  // counted in `tally` (gives the standard-meal volume) but the
  // `specials` list excludes REGULAR — kitchen brief only cares about
  // the exceptions.
  const tally = new Map();
  for (const b of enriched) {
    const d = b.jemaah?.dietary || 'REGULAR';
    tally.set(d, (tally.get(d) || 0) + (b.paxCount || 1));
  }
  const dietarySpecials = enriched
    .filter((b) => (b.jemaah?.dietary || 'REGULAR') !== 'REGULAR')
    .sort((a, b) => {
      const da = a.jemaah.dietary || '';
      const db_ = b.jemaah.dietary || '';
      if (da !== db_) return da.localeCompare(db_);
      return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
    });
  const dietarySummary = {
    tally: Object.fromEntries(tally),
    specials: dietarySpecials,
    totalPax: enriched.reduce((acc, b) => acc + (b.paxCount || 1), 0),
    specialPax: dietarySpecials.reduce((acc, b) => acc + (b.paxCount || 1), 0),
  };

  // Stage 228 — per-pickup pax rollup for the crew brief panel. Mirrors
  // S205's adminDashboard summary; TBD always renders last regardless
  // of size so crew sees the unfinished work clearly.
  const pickupMap = new Map();
  for (const b of enriched) {
    const key = b.pickupId || '__TBD__';
    const label = b.pickup?.label || 'TBD (belum pilih)';
    const departTime = b.pickup?.departTime || null;
    const row = pickupMap.get(key) || { id: b.pickupId || null, label, departTime, paxCount: 0, count: 0 };
    row.paxCount += b.paxCount || 1;
    row.count += 1;
    pickupMap.set(key, row);
  }
  const pickupSummary = [...pickupMap.values()].sort((a, b) => {
    if (a.id === null && b.id !== null) return 1;
    if (a.id !== null && b.id === null) return -1;
    return b.paxCount - a.paxCount;
  });

  return { ...paket, bookings: enriched, dietarySummary, pickupSummary };
}

// ─── 5ww: per-day attendance ────────────────────────────────

/**
 * Gate helper — returns paket id when crew is assigned, else null.
 */
async function loadAssignedPaketId(userId, slug) {
  const row = await db.paketCrew.findFirst({
    where: { userId, paket: { slug, deletedAt: null } },
    select: { paketId: true },
  });
  return row?.paketId || null;
}

/**
 * Overview of all PaketDay rows for an assigned paket, each with the count
 * of present marks and total active bookings. Returns null when crew isn't
 * assigned (route → 404). Days ordered by dayNumber asc.
 */
export async function listAttendanceDays({ userId, slug }) {
  const paketId = await loadAssignedPaketId(userId, slug);
  if (!paketId) return null;

  const paket = await db.paket.findUnique({
    where: { id: paketId },
    select: {
      id: true, slug: true, title: true,
      departureDate: true, durationDays: true,
      bookings: {
        where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        select: { id: true },
      },
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true, dayNumber: true, dateLabel: true, monthLabel: true,
          title: true, highlight: true,
          attendanceMarks: {
            // Scope marks to active bookings to keep counts honest if a
            // booking is later cancelled.
            where: { booking: { status: { notIn: ['CANCELLED', 'REFUNDED'] } } },
            select: { present: true },
          },
        },
      },
    },
  });
  if (!paket) return null;

  const totalActive = paket.bookings.length;
  const days = paket.days.map((d) => {
    const presentCount = d.attendanceMarks.filter((m) => m.present).length;
    const markedCount = d.attendanceMarks.length;
    return {
      id: d.id, dayNumber: d.dayNumber, dateLabel: d.dateLabel,
      monthLabel: d.monthLabel, title: d.title, highlight: d.highlight,
      presentCount, markedCount, totalActive,
    };
  });
  const trend = buildAttendanceTrend(days, totalActive);
  return { ...paket, days, totalActive, trend };
}

/**
 * Stage 140 — compute the per-day present% trend for the sparkline.
 * `days` already comes ordered by dayNumber asc. Each tick carries the
 * raw counts so the view can label hover-titles ("4/12 present, 8 not
 * yet marked"). avgPct rolls up across days that have been marked at
 * all — days with zero marks are noise, not signal.
 */
export function buildAttendanceTrend(days, totalActive) {
  if (!days || days.length === 0 || totalActive === 0) {
    return { ticks: [], avgPct: null, markedDayCount: 0 };
  }
  const ticks = days.map((d) => ({
    dayNumber: d.dayNumber,
    dateLabel: d.dateLabel,
    title: d.title,
    presentCount: d.presentCount,
    markedCount: d.markedCount,
    totalActive,
    // Rate = present ÷ total active jemaah (consistent with admin report).
    // Unmarked days look like 0% — that's intentional: a day with zero
    // marks is "we have no data" and the chart honestly shows the dip.
    presentPct: Math.round((d.presentCount / totalActive) * 100),
    hasData: d.markedCount > 0,
  }));
  const dataTicks = ticks.filter((t) => t.hasData);
  const avgPct = dataTicks.length === 0
    ? null
    : Math.round(dataTicks.reduce((sum, t) => sum + t.presentPct, 0) / dataTicks.length);
  return { ticks, avgPct, markedDayCount: dataTicks.length };
}

/**
 * Per-day grid: jemaah list + existing marks. Returns null when crew not
 * assigned OR when the day doesn't belong to the paket (anti-enumeration).
 */
export async function getAttendanceGrid({ userId, slug, dayId }) {
  const paketId = await loadAssignedPaketId(userId, slug);
  if (!paketId) return null;

  const day = await db.paketDay.findFirst({
    where: { id: dayId, paketId },
    select: {
      id: true, dayNumber: true, dateLabel: true, monthLabel: true,
      title: true, description: true, paketId: true,
    },
  });
  if (!day) return null;

  const paket = await db.paket.findUnique({
    where: { id: paketId },
    select: {
      id: true, slug: true, title: true,
    },
  });

  const bookings = await db.booking.findMany({
    where: { paketId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    orderBy: [{ kelas: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true,
      jemaah: { select: { fullName: true, phone: true } },
      room: { select: { roomNo: true } },
      attendanceMarks: {
        where: { paketDayId: day.id },
        select: { present: true, notes: true, markedAt: true, markedBy: { select: { fullName: true } } },
        take: 1,
      },
    },
  });

  return {
    paket, day,
    bookings: bookings.map((b) => ({
      ...b,
      mark: b.attendanceMarks[0] || null,
    })),
  };
}

/**
 * Upsert one attendance mark. Refuses (HttpError 404) when crew isn't
 * assigned to the paket, or when the day/booking don't belong to it
 * (anti-enumeration — same 404 either way).
 *
 * Re-marking the same (booking, day) is idempotent — flips `present` /
 * updates `notes` / refreshes `markedAt+By`. No audit row (high-volume
 * operation; audit would spam the log).
 */
export async function setAttendanceMark({ req, actor, userId, slug, dayId, bookingId, present, notes }) {
  const paketId = await loadAssignedPaketId(userId, slug);
  if (!paketId) throw new HttpError(404, 'Paket tidak ditemukan atau Anda tidak di-assign', 'NOT_ASSIGNED');

  // Validate (dayId, bookingId) both belong to this paket
  const [day, booking] = await Promise.all([
    db.paketDay.findFirst({ where: { id: dayId, paketId }, select: { id: true } }),
    db.booking.findFirst({ where: { id: bookingId, paketId }, select: { id: true } }),
  ]);
  if (!day || !booking) throw new HttpError(404, 'Day/booking tidak cocok dengan paket', 'NOT_FOUND');

  const cleanNotes = (notes || '').toString().trim().slice(0, 500) || null;
  const presentBool = present === true || present === 'true' || present === 'on';

  return db.attendanceMark.upsert({
    where: { bookingId_paketDayId: { bookingId, paketDayId: dayId } },
    update: {
      present: presentBool,
      notes: cleanNotes,
      markedByUserId: userId,
      markedAt: new Date(),
    },
    create: {
      bookingId, paketDayId: dayId,
      present: presentBool, notes: cleanNotes,
      markedByUserId: userId,
    },
  });
}

// ─── 5zz: admin attendance report (cross-day + cross-jemaah view) ─

/**
 * Admin-facing attendance summary for one paket. Read-only — admin doesn't
 * mark attendance themselves (that's the crew's job, 5ww), they audit it.
 *
 * Returns null when paket missing or soft-deleted (route → 404).
 *
 * Shape:
 *   paket:    { id, slug, title, departureDate, durationDays }
 *   days:     [{ id, dayNumber, title, dateLabel, presentCount, markedCount, totalActive }]
 *   bookings: [{ id, bookingNo, kelas, paxCount, jemaah:{fullName, phone},
 *               daysPresent, daysMarked, daysTotal, attendanceRatePct }]
 *   totalDays: number of itinerary days
 *   totalActive: count of active bookings
 *
 * Active bookings only (CANCELLED/REFUNDED excluded) so the rate reflects
 * the trip-roster, not the historical roster.
 */
export async function getPaketAttendanceReport(paketSlug) {
  const paket = await db.paket.findFirst({
    where: { slug: paketSlug, deletedAt: null },
    select: {
      id: true, slug: true, title: true,
      departureDate: true, returnDate: true, durationDays: true,
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true, dayNumber: true, dateLabel: true, monthLabel: true,
          title: true,
        },
      },
      bookings: {
        where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        orderBy: [{ kelas: 'asc' }, { createdAt: 'asc' }],
        select: {
          // Stage 231 — booking tags (S226) on crew manifest so muthawwif
          // sees VIP/LANSIA/etc. at a glance.
          id: true, bookingNo: true, kelas: true, paxCount: true, status: true, tags: true,
          jemaah: { select: { fullName: true, phone: true } },
          attendanceMarks: {
            select: { paketDayId: true, present: true },
          },
        },
      },
    },
  });
  if (!paket) return null;

  const totalDays = paket.days.length;
  const totalActive = paket.bookings.length;

  // Per-day rollup: counts derived from booking.attendanceMarks (already
  // scoped to active bookings via the where clause above).
  const perDayPresent = new Map();
  const perDayMarked = new Map();
  for (const b of paket.bookings) {
    for (const m of b.attendanceMarks) {
      perDayMarked.set(m.paketDayId, (perDayMarked.get(m.paketDayId) || 0) + 1);
      if (m.present) perDayPresent.set(m.paketDayId, (perDayPresent.get(m.paketDayId) || 0) + 1);
    }
  }
  const days = paket.days.map((d) => ({
    ...d,
    presentCount: perDayPresent.get(d.id) || 0,
    markedCount: perDayMarked.get(d.id) || 0,
    totalActive,
  }));

  const bookings = paket.bookings.map((b) => {
    const daysMarked = b.attendanceMarks.length;
    const daysPresent = b.attendanceMarks.filter((m) => m.present).length;
    return {
      id: b.id, bookingNo: b.bookingNo, kelas: b.kelas,
      paxCount: b.paxCount, status: b.status,
      jemaah: b.jemaah,
      daysPresent, daysMarked,
      daysTotal: totalDays,
      // Rate over days marked-as-present out of total itinerary days. Days
      // not yet marked count as "not present" — keeps the metric honest when
      // crew hasn't filled the form yet (an unmarked day with the jemaah
      // actually attending isn't tracked).
      attendanceRatePct: totalDays === 0 ? 0 : Math.round((daysPresent / totalDays) * 100),
    };
  });

  // Stage 140 — sparkline trend uses the same shape as the crew side
  // so the SVG render in admin + crew views share one helper.
  const trend = buildAttendanceTrend(days, totalActive);
  return {
    paket: { id: paket.id, slug: paket.slug, title: paket.title,
             departureDate: paket.departureDate, durationDays: paket.durationDays },
    days, bookings, totalDays, totalActive, trend,
  };
}

// ─── Admin assignment management ─────────────────────────────

export async function assignCrewToPaket({ req, actor, paketSlug, userId }) {
  const paket = await db.paket.findUnique({ where: { slug: paketSlug }, select: { id: true } });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, status: true, deletedAt: true, email: true } });
  if (!user) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  if (user.role !== 'MUTHAWWIF') {
    throw new HttpError(409, `Hanya MUTHAWWIF yang bisa di-assign sebagai crew (user role: ${user.role})`, 'BAD_ROLE');
  }
  if (user.status !== 'ACTIVE' || user.deletedAt) {
    throw new HttpError(409, 'User tidak aktif', 'USER_INACTIVE');
  }

  // Composite PK makes this naturally idempotent — upsert avoids 409 on double-assign.
  const row = await db.paketCrew.upsert({
    where: { paketId_userId: { paketId: paket.id, userId } },
    update: {}, // no-op on existing
    create: { paketId: paket.id, userId },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaketCrew', entityId: `${paket.id}:${userId}`,
    after: { paketSlug, userId, userEmail: user.email },
  });
  return row;
}

export async function unassignCrewFromPaket({ req, actor, paketSlug, userId }) {
  const paket = await db.paket.findUnique({ where: { slug: paketSlug }, select: { id: true } });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  const existing = await db.paketCrew.findUnique({
    where: { paketId_userId: { paketId: paket.id, userId } },
  });
  if (!existing) throw new HttpError(404, 'Assignment tidak ditemukan', 'ASSIGNMENT_NOT_FOUND');
  await db.paketCrew.delete({
    where: { paketId_userId: { paketId: paket.id, userId } },
  });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'PaketCrew', entityId: `${paket.id}:${userId}`,
    before: { paketSlug, userId },
  });
}

/**
 * 5ss: build offline-friendly CSV of an assigned paket's manifest. Returns
 * null when the crew isn't assigned (route turns this into 404). Strips
 * money fields just like `getAssignedManifest` — same separation of duty.
 *
 *   - UTF-8 BOM so Excel detects encoding correctly
 *   - RFC 4180 quoting (`"`, `,`, newline → wrap + double-quote escape)
 *   - One row per active booking + header row
 *   - One column per curated doc type (5 types via `pillsForJemaah`)
 */
export async function buildCrewManifestCsv({ userId, slug }) {
  const data = await getAssignedManifest({ userId, slug });
  if (!data) return null;

  const sampleTypes = data.bookings[0]?.docPills?.map((p) => p.type) || [];
  const docHeaders = sampleTypes.map((t) => `Doc ${t}`);

  const headers = [
    'Booking No', 'Status', 'Kelas', 'PAX',
    'Nama Jemaah', 'Telepon', 'Kontak Darurat',
    'Paspor', 'Paspor Expire',
    'Kamar No', 'Lantai', 'Wing',
    ...docHeaders,
  ];

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = data.bookings.map((b) => {
    const docMap = new Map((b.docPills || []).map((p) => [p.type, p.state]));
    const cells = [
      b.bookingNo,
      b.status,
      b.kelas,
      b.paxCount,
      b.jemaah?.fullName,
      b.jemaah?.phone,
      b.jemaah?.emergencyContact,
      b.jemaah?.passportNo,
      b.jemaah?.passportExpiry ? b.jemaah.passportExpiry.toISOString().slice(0, 10) : '',
      b.room?.roomNo,
      b.room?.floor,
      b.room?.wing,
      ...sampleTypes.map((t) => docMap.get(t) || 'missing'),
    ];
    return cells.map(escape).join(',');
  });

  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const safeSlug = data.slug.replace(/[^a-z0-9_-]/gi, '_');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `crew_manifest_${safeSlug}_${today}.csv`;
  return { filename, csv, count: data.bookings.length };
}

/**
 * Crew options for the admin assignment dropdown — every ACTIVE MUTHAWWIF.
 * Used to populate the "Assign crew" form on the paket edit page.
 */
export async function listAvailableCrew() {
  return db.user.findMany({
    where: { role: 'MUTHAWWIF', status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });
}

/**
 * Crew currently assigned to a paket. Used to render the "Assigned" list
 * on the paket edit page.
 */
export async function listAssignedCrewForPaket(paketSlug) {
  const rows = await db.paketCrew.findMany({
    where: { paket: { slug: paketSlug } },
    include: { user: { select: { id: true, email: true, fullName: true } } },
    orderBy: { assignedAt: 'asc' },
  });
  return rows.map((r) => ({ ...r.user, assignedAt: r.assignedAt }));
}
