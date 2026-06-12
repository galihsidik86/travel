import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'];
const KELAS = ['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP'];
const HOTEL_CITIES = ['MADINAH', 'MEKKAH', 'JEDDAH', 'AQSA', 'PETRA', 'AMMAN', 'ISTANBUL', 'CAIRO', 'DUBAI', 'JAKARTA'];

// Coerce blank strings to undefined
const blank = (v) => (v === '' || v == null ? undefined : v);
const optStr = z.preprocess(blank, z.string().max(2000).optional());
const optStrLong = z.preprocess(blank, z.string().max(65535).optional());
const optInt = z.preprocess((v) => (blank(v) === undefined ? undefined : Number(v)), z.number().int().optional());
const optMoney = z.preprocess((v) => (blank(v) === undefined ? undefined : Number(v)), z.number().nonnegative().optional());
const reqDate = z.preprocess((v) => new Date(String(v)), z.date());

// Convert multiline textarea → string[]
function linesToArr(input) {
  if (input == null || input === '') return [];
  return String(input).split('\n').map((s) => s.trim()).filter(Boolean);
}

export const PaketSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Slug harus huruf kecil, angka, dan strip (mis. paket-ramadhan-2027)').max(190),
  title: z.string().min(3, 'Judul minimal 3 karakter').max(190),
  subtitle: optStr,
  heroTitleHtml: optStrLong,
  heroTitleHtmlVariantB: optStrLong, // Stage 50 — optional A/B test copy
  ctaTextVariantA: optStr, // Stage 52 — optional CTA button text override
  ctaTextVariantB: optStr,
  // Stage 61 — ROI input. 3-state preprocessor: empty→null (clear),
  // missing→undefined (no change), valid number→stored.
  adsSpendIdr: z.preprocess(
    (v) => v === '' || v == null ? null : Number(v),
    z.union([z.number().min(0).max(1e15), z.null()]).optional(),
  ),
  adsNotes: optStrLong,
  arabicTagline: optStrLong,
  translitTagline: optStrLong,
  departureDate: reqDate,
  returnDate: reqDate,
  durationDays: z.preprocess((v) => Number(v), z.number().int().min(1).max(60)),
  airline: optStr,
  airlineCode: optStr,
  routeFrom: optStr,
  routeTo: optStr,
  heroDescription: optStrLong,
  // textareas — each line = one item
  inclusionsText: optStrLong,
  exclusionsText: optStrLong,
  kursiTotal: z.preprocess((v) => Number(v), z.number().int().min(1).max(500)),
  manifestClosesAt: z.preprocess((v) => (blank(v) === undefined ? null : new Date(String(v))), z.date().nullable().optional()),
  status: z.enum(STATUSES).default('DRAFT'),
  // Form input is a percentage (e.g. "6.5" for 6.5%); store as decimal fraction (0.0650).
  komisiRatePct: z.preprocess(
    (v) => (blank(v) === undefined ? undefined : Number(v)),
    z.number().min(0, 'Min 0%').max(50, 'Max 50% — sanity cap').optional(),
  ),
  // Stage 22 — per-pax fully-loaded cost. Nullable: empty input clears
  // (admin opts out of margin computation), non-empty stores the value.
  // 3-state preprocessor (undefined / null / number) mirrors the pattern in
  // userAdmin.js komisiOverridePct so "clear" actually persists.
  costPerPaxIdr: z.preprocess(
    (v) => {
      if (v == null) return undefined;
      const s = String(v).trim();
      if (s === '') return null;          // explicit clear
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    },
    z.union([z.number().nonnegative('Biaya tidak boleh negatif'), z.null()]).optional(),
  ),
  costNotes: optStrLong,
  // Stage 222 — WhatsApp group invite URL for trip coordination chat.
  // Empty string → clear; undefined → no change; non-empty stores.
  // Validates as http(s) URL when present; jemaah/crew click-through
  // assumes a real wa.me / chat.whatsapp.com link.
  waGroupUrl: z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      const s = blank(v);
      return s === undefined ? null : String(s);
    },
    z.union([
      z.string().url('WhatsApp group URL harus diawali http(s)://').max(500),
      z.null(),
    ]).optional(),
  ),
}).refine((d) => d.returnDate >= d.departureDate, {
  message: 'Tanggal pulang tidak boleh sebelum tanggal berangkat',
  path: ['returnDate'],
});

const PriceRowSchema = z.object({
  kelas: z.enum(KELAS),
  label: optStr,
  caption: optStr,
  priceIdr: z.preprocess((v) => Number(v), z.number().nonnegative()),
  cicilanIdr: optMoney,
  cicilanMonths: optInt,
  isFeatured: z.preprocess((v) => v === 'on' || v === true || v === 'true', z.boolean()),
});

// `pricesRaw` is shaped like { QUAD: {...}, TRIPLE: {...}, ... } from the form
export function parsePrices(pricesRaw) {
  const out = [];
  for (const kelas of KELAS) {
    const row = pricesRaw?.[kelas];
    if (!row) continue;
    // Skip empty rows (no price filled)
    if (blank(row.priceIdr) === undefined) continue;
    out.push(PriceRowSchema.parse({ kelas, ...row }));
  }
  return out;
}

function toPaketData(parsed, userId) {
  return {
    slug: parsed.slug,
    title: parsed.title,
    subtitle: parsed.subtitle ?? null,
    heroTitleHtml: parsed.heroTitleHtml ?? null,
    heroTitleHtmlVariantB: parsed.heroTitleHtmlVariantB ?? null,
    ctaTextVariantA: parsed.ctaTextVariantA ?? null,
    ctaTextVariantB: parsed.ctaTextVariantB ?? null,
    // Stage 61 — same 3-state pattern as costPerPaxIdr.
    ...(parsed.adsSpendIdr !== undefined
      ? { adsSpendIdr: parsed.adsSpendIdr == null ? null : parsed.adsSpendIdr.toFixed(2) }
      : {}),
    ...(parsed.adsNotes !== undefined ? { adsNotes: parsed.adsNotes ?? null } : {}),
    arabicTagline: parsed.arabicTagline ?? null,
    translitTagline: parsed.translitTagline ?? null,
    departureDate: parsed.departureDate,
    returnDate: parsed.returnDate,
    durationDays: parsed.durationDays,
    airline: parsed.airline ?? null,
    airlineCode: parsed.airlineCode ?? null,
    routeFrom: parsed.routeFrom ?? null,
    routeTo: parsed.routeTo ?? null,
    heroDescription: parsed.heroDescription ?? null,
    inclusions: linesToArr(parsed.inclusionsText),
    exclusions: linesToArr(parsed.exclusionsText),
    kursiTotal: parsed.kursiTotal,
    manifestClosesAt: parsed.manifestClosesAt ?? null,
    status: parsed.status,
    publishedAt: parsed.status === 'ACTIVE' ? new Date() : null,
    ...(parsed.komisiRatePct != null ? { komisiRate: (parsed.komisiRatePct / 100).toFixed(4) } : {}),
    // Stage 22 — costPerPaxIdr handles 3 states:
    //   undefined (not in body) → no DB write
    //   null (explicit clear)   → set to null
    //   number                  → store
    ...(parsed.costPerPaxIdr !== undefined
      ? { costPerPaxIdr: parsed.costPerPaxIdr == null ? null : parsed.costPerPaxIdr.toFixed(2) }
      : {}),
    ...(parsed.costNotes !== undefined ? { costNotes: parsed.costNotes ?? null } : {}),
    // Stage 222 — same 3-state pattern for the WhatsApp group URL.
    ...(parsed.waGroupUrl !== undefined ? { waGroupUrl: parsed.waGroupUrl ?? null } : {}),
    ...(userId ? { createdById: userId } : {}),
  };
}

export async function createPaket({ req, actor, input, prices }) {
  const existing = await db.paket.findUnique({ where: { slug: input.slug } });
  if (existing) {
    throw new HttpError(409, `Slug "${input.slug}" sudah dipakai`, 'SLUG_TAKEN');
  }

  const paket = await db.$transaction(async (tx) => {
    const created = await tx.paket.create({ data: toPaketData(input, actor.id) });
    if (prices.length > 0) {
      await tx.paketHarga.createMany({
        data: prices.map((p) => ({
          paketId: created.id,
          kelas: p.kelas,
          label: p.label ?? null,
          caption: p.caption ?? null,
          priceIdr: p.priceIdr.toFixed(2),
          cicilanIdr: p.cicilanIdr != null ? p.cicilanIdr.toFixed(2) : null,
          cicilanMonths: p.cicilanMonths ?? null,
          isFeatured: p.isFeatured,
        })),
      });
    }
    return created;
  });

  await audit({
    req, actor,
    action: 'CREATE', entity: 'Paket', entityId: paket.id,
    after: { slug: paket.slug, title: paket.title, status: paket.status, prices: prices.length },
  });

  return paket;
}

export async function updatePaket({ req, actor, slug, input, prices }) {
  const before = await db.paket.findUnique({ where: { slug } });
  if (!before || before.deletedAt) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

  // If slug is changing, make sure new slug isn't taken
  if (input.slug !== before.slug) {
    const clash = await db.paket.findUnique({ where: { slug: input.slug } });
    if (clash) throw new HttpError(409, `Slug "${input.slug}" sudah dipakai`, 'SLUG_TAKEN');
  }

  const data = toPaketData(input, null);
  // Don't overwrite publishedAt if it was already set
  if (before.publishedAt && input.status === 'ACTIVE') data.publishedAt = before.publishedAt;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.paket.update({ where: { id: before.id }, data });
    // Upsert each price row provided. Don't delete others (preserves history).
    for (const p of prices) {
      await tx.paketHarga.upsert({
        where: { paketId_kelas: { paketId: before.id, kelas: p.kelas } },
        update: {
          label: p.label ?? null,
          caption: p.caption ?? null,
          priceIdr: p.priceIdr.toFixed(2),
          cicilanIdr: p.cicilanIdr != null ? p.cicilanIdr.toFixed(2) : null,
          cicilanMonths: p.cicilanMonths ?? null,
          isFeatured: p.isFeatured,
        },
        create: {
          paketId: before.id,
          kelas: p.kelas,
          label: p.label ?? null,
          caption: p.caption ?? null,
          priceIdr: p.priceIdr.toFixed(2),
          cicilanIdr: p.cicilanIdr != null ? p.cicilanIdr.toFixed(2) : null,
          cicilanMonths: p.cicilanMonths ?? null,
          isFeatured: p.isFeatured,
        },
      });
    }
    return u;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Paket', entityId: updated.id,
    before: { slug: before.slug, status: before.status, title: before.title },
    after: { slug: updated.slug, status: updated.status, title: updated.title, prices: prices.length },
  });

  return updated;
}

// ─── PaketHotel CRUD ─────────────────────────────────────────

export const HotelSchema = z.object({
  city: z.enum(HOTEL_CITIES),
  name: z.string().min(2).max(190),
  stars: z.preprocess((v) => Number(v), z.number().int().min(1).max(5)),
  distance: optStr,
  description: optStrLong,
  nights: z.preprocess((v) => Number(v), z.number().int().min(1).max(60)),
  order: z.preprocess((v) => (blank(v) === undefined ? 0 : Number(v)), z.number().int().min(0).max(99)).default(0),
});

async function loadPaketBySlug(slug) {
  const paket = await db.paket.findUnique({ where: { slug } });
  if (!paket || paket.deletedAt) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  return paket;
}

async function loadOwnedHotel(paketId, hotelId) {
  const hotel = await db.paketHotel.findUnique({ where: { id: hotelId } });
  if (!hotel) throw new HttpError(404, 'Hotel tidak ditemukan', 'HOTEL_NOT_FOUND');
  if (hotel.paketId !== paketId) throw new HttpError(403, 'Hotel ini bukan milik paket tersebut', 'FORBIDDEN');
  return hotel;
}

export async function addHotel({ req, actor, paketSlug, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const data = HotelSchema.parse(input);
  const hotel = await db.paketHotel.create({
    data: {
      paketId: paket.id,
      city: data.city,
      name: data.name,
      stars: data.stars,
      distance: data.distance ?? null,
      description: data.description ?? null,
      nights: data.nights,
      order: data.order,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaketHotel', entityId: hotel.id,
    after: { paketId: paket.id, paketSlug, city: hotel.city, name: hotel.name },
  });
  return hotel;
}

export async function updateHotel({ req, actor, paketSlug, hotelId, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedHotel(paket.id, hotelId);
  const data = HotelSchema.parse(input);
  const hotel = await db.paketHotel.update({
    where: { id: before.id },
    data: {
      city: data.city,
      name: data.name,
      stars: data.stars,
      distance: data.distance ?? null,
      description: data.description ?? null,
      nights: data.nights,
      order: data.order,
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'PaketHotel', entityId: hotel.id,
    before: { city: before.city, name: before.name, nights: before.nights },
    after: { city: hotel.city, name: hotel.name, nights: hotel.nights },
  });
  return hotel;
}

export async function deleteHotel({ req, actor, paketSlug, hotelId }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedHotel(paket.id, hotelId);
  await db.paketHotel.delete({ where: { id: before.id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'PaketHotel', entityId: before.id,
    before: { city: before.city, name: before.name },
  });
}

// ─── PaketDay CRUD ───────────────────────────────────────────

export const DaySchema = z.object({
  dayNumber: z.preprocess((v) => Number(v), z.number().int().min(1).max(60)),
  dayRange: optStr,
  dateLabel: optStr,
  monthLabel: optStr,
  title: z.string().min(2).max(190),
  description: optStrLong.pipe(z.string().min(1, 'Deskripsi wajib diisi')),
  tagsText: optStr, // textarea, comma-separated → JSON array
  highlight: z.preprocess((v) => v === 'on' || v === true || v === 'true', z.boolean()).default(false),
  pembimbingTitle: optStr,
  pembimbingNote: optStrLong,
});

async function loadOwnedDay(paketId, dayId) {
  const day = await db.paketDay.findUnique({ where: { id: dayId } });
  if (!day) throw new HttpError(404, 'Hari itinerary tidak ditemukan', 'DAY_NOT_FOUND');
  if (day.paketId !== paketId) throw new HttpError(403, 'Hari itinerary ini bukan milik paket tersebut', 'FORBIDDEN');
  return day;
}

function tagsArr(text) {
  if (!text) return [];
  return String(text).split(',').map((s) => s.trim()).filter(Boolean);
}

function dayDataFrom(data) {
  return {
    dayNumber: data.dayNumber,
    dayRange: data.dayRange ?? null,
    dateLabel: data.dateLabel ?? null,
    monthLabel: data.monthLabel ?? null,
    title: data.title,
    description: data.description,
    tags: tagsArr(data.tagsText),
    highlight: data.highlight,
    pembimbingTitle: data.pembimbingTitle ?? null,
    pembimbingNote: data.pembimbingNote ?? null,
  };
}

export async function addDay({ req, actor, paketSlug, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const data = DaySchema.parse(input);
  const exists = await db.paketDay.findUnique({
    where: { paketId_dayNumber: { paketId: paket.id, dayNumber: data.dayNumber } },
  });
  if (exists) throw new HttpError(409, `Hari ${data.dayNumber} sudah ada untuk paket ini`, 'DAY_NUMBER_TAKEN');

  const day = await db.paketDay.create({
    data: { paketId: paket.id, ...dayDataFrom(data) },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaketDay', entityId: day.id,
    after: { paketSlug, dayNumber: day.dayNumber, title: day.title },
  });
  return day;
}

export async function updateDay({ req, actor, paketSlug, dayId, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedDay(paket.id, dayId);
  const data = DaySchema.parse(input);
  if (data.dayNumber !== before.dayNumber) {
    const clash = await db.paketDay.findUnique({
      where: { paketId_dayNumber: { paketId: paket.id, dayNumber: data.dayNumber } },
    });
    if (clash) throw new HttpError(409, `Hari ${data.dayNumber} sudah ada untuk paket ini`, 'DAY_NUMBER_TAKEN');
  }
  const day = await db.paketDay.update({
    where: { id: before.id },
    data: dayDataFrom(data),
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'PaketDay', entityId: day.id,
    before: { dayNumber: before.dayNumber, title: before.title },
    after: { dayNumber: day.dayNumber, title: day.title },
  });
  return day;
}

export async function deleteDay({ req, actor, paketSlug, dayId }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedDay(paket.id, dayId);
  await db.paketDay.delete({ where: { id: before.id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'PaketDay', entityId: before.id,
    before: { dayNumber: before.dayNumber, title: before.title },
  });
}

// ─── Room CRUD (Bunking schema) ──────────────────────────────

const KELAS_DEFAULT_CAP = { QUAD: 4, TRIPLE: 3, DOUBLE: 2, VVIP: 1 };

export const RoomSchema = z.object({
  roomNo: z.string().min(1, 'Nomor kamar wajib').max(50),
  floor: z.preprocess((v) => (blank(v) === undefined ? null : Number(v)), z.number().int().min(0).max(99).nullable().optional()),
  wing: optStr,
  kelas: z.enum(KELAS),
  capacity: z.preprocess((v) => (blank(v) === undefined ? undefined : Number(v)), z.number().int().min(1).max(20).optional()),
  notes: optStrLong,
});

async function loadOwnedRoom(paketId, roomId) {
  const room = await db.room.findUnique({ where: { id: roomId } });
  if (!room) throw new HttpError(404, 'Kamar tidak ditemukan', 'ROOM_NOT_FOUND');
  if (room.paketId !== paketId) throw new HttpError(403, 'Kamar ini bukan milik paket tersebut', 'FORBIDDEN');
  return room;
}

export async function addRoom({ req, actor, paketSlug, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const data = RoomSchema.parse(input);
  const capacity = data.capacity ?? KELAS_DEFAULT_CAP[data.kelas];

  // composite unique check
  const clash = await db.room.findUnique({
    where: { paketId_roomNo: { paketId: paket.id, roomNo: data.roomNo } },
  });
  if (clash) throw new HttpError(409, `Nomor kamar "${data.roomNo}" sudah dipakai`, 'ROOM_NO_TAKEN');

  const room = await db.room.create({
    data: {
      paketId: paket.id,
      roomNo: data.roomNo,
      floor: data.floor ?? null,
      wing: data.wing ?? null,
      kelas: data.kelas,
      capacity,
      notes: data.notes ?? null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'Room', entityId: room.id,
    after: { paketSlug, roomNo: room.roomNo, kelas: room.kelas, capacity: room.capacity },
  });
  return room;
}

export async function updateRoom({ req, actor, paketSlug, roomId, input }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedRoom(paket.id, roomId);
  const data = RoomSchema.parse(input);
  const capacity = data.capacity ?? KELAS_DEFAULT_CAP[data.kelas];

  if (data.roomNo !== before.roomNo) {
    const clash = await db.room.findUnique({
      where: { paketId_roomNo: { paketId: paket.id, roomNo: data.roomNo } },
    });
    if (clash) throw new HttpError(409, `Nomor kamar "${data.roomNo}" sudah dipakai`, 'ROOM_NO_TAKEN');
  }

  // If reducing capacity, make sure current occupancy still fits
  if (capacity < before.capacity) {
    const occ = await db.booking.aggregate({
      where: { roomId: before.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      _sum: { paxCount: true },
    });
    const occupied = occ._sum.paxCount ?? 0;
    if (occupied > capacity) {
      throw new HttpError(409,
        `Tidak bisa kurangi kapasitas ke ${capacity}: kamar sudah terisi ${occupied} pax`,
        'CAPACITY_BELOW_OCCUPANCY');
    }
  }

  const room = await db.room.update({
    where: { id: before.id },
    data: {
      roomNo: data.roomNo,
      floor: data.floor ?? null,
      wing: data.wing ?? null,
      kelas: data.kelas,
      capacity,
      notes: data.notes ?? null,
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Room', entityId: room.id,
    before: { roomNo: before.roomNo, kelas: before.kelas, capacity: before.capacity },
    after: { roomNo: room.roomNo, kelas: room.kelas, capacity: room.capacity },
  });
  return room;
}

export async function deleteRoom({ req, actor, paketSlug, roomId }) {
  const paket = await loadPaketBySlug(paketSlug);
  const before = await loadOwnedRoom(paket.id, roomId);

  // Refuse if any active booking still assigned
  const assigned = await db.booking.count({
    where: { roomId: before.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
  });
  if (assigned > 0) {
    throw new HttpError(409,
      `Kamar ${before.roomNo} masih punya ${assigned} booking aktif — lepas (unassign) dulu sebelum hapus`,
      'ROOM_HAS_BOOKINGS');
  }

  await db.room.delete({ where: { id: before.id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Room', entityId: before.id,
    before: { roomNo: before.roomNo, kelas: before.kelas, capacity: before.capacity },
  });
}

/**
 * Clone a paket into a fresh DRAFT. Copies:
 *   - the Paket row (minus slug/title/dates/status/kursiTerisi which are
 *     reset or supplied by the caller)
 *   - PaketHotel rows (same cities, stars, nights, etc.)
 *   - PaketDay rows (same itinerary structure)
 *   - PaketHarga rows (price tiers + cicilan + isFeatured flag)
 *   - optionally AgentPaketKomisi (per-agent overrides) — admin opts in
 *     since "same agents same rates" is a common pattern but not universal
 *
 * Does NOT copy: bookings, payments, komisi, rooms, crew assignments,
 * incidents. Those are per-trip operational data — a clone is a template,
 * not a historical record.
 *
 * The new paket lands in DRAFT with kursiTerisi=0. Audit row carries
 * `clonedFromSlug` so lineage is queryable.
 */
const CloneSchema = z.object({
  newSlug: z.string().regex(SLUG_RE, 'Slug harus huruf kecil, angka, dan strip').max(190),
  newTitle: z.string().min(3, 'Judul baru minimal 3 karakter').max(190),
  newDepartureDate: reqDate,
  // Optional return date — defaults to newDepartureDate + same durationDays
  // as the source so the duration stays consistent without admin having to
  // recompute. Override only when the trip length is genuinely different.
  newReturnDate: z.preprocess(
    (v) => (blank(v) === undefined ? undefined : new Date(String(v))),
    z.date().optional(),
  ),
  includeAgentOverrides: z.preprocess(
    (v) => v === true || v === 'true' || v === 'on',
    z.boolean(),
  ).default(false),
});

export async function clonePaket({ req, actor, sourceSlug, input }) {
  const parsed = CloneSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input clone tidak valid', 'BAD_INPUT');
  }
  const data = parsed.data;

  const source = await db.paket.findUnique({
    where: { slug: sourceSlug },
    include: {
      hotels: true,
      days: true,
      prices: true,
      agentOverrides: true,
    },
  });
  if (!source || source.deletedAt) {
    throw new HttpError(404, 'Paket sumber tidak ditemukan', 'PAKET_NOT_FOUND');
  }

  const clash = await db.paket.findUnique({ where: { slug: data.newSlug } });
  if (clash) {
    throw new HttpError(409, `Slug "${data.newSlug}" sudah dipakai`, 'SLUG_TAKEN');
  }

  // Default returnDate preserves the source's durationDays
  const newReturnDate = data.newReturnDate
    || new Date(data.newDepartureDate.getTime() + source.durationDays * 86_400_000);
  const newDurationDays = Math.max(1,
    Math.round((newReturnDate - data.newDepartureDate) / 86_400_000));

  const cloned = await db.$transaction(async (tx) => {
    const created = await tx.paket.create({
      data: {
        slug: data.newSlug,
        title: data.newTitle,
        subtitle: source.subtitle,
        heroTitleHtml: source.heroTitleHtml,
        heroTitleHtmlVariantB: source.heroTitleHtmlVariantB,
        ctaTextVariantA: source.ctaTextVariantA,
        ctaTextVariantB: source.ctaTextVariantB,
        arabicTagline: source.arabicTagline,
        translitTagline: source.translitTagline,
        departureDate: data.newDepartureDate,
        returnDate: newReturnDate,
        durationDays: newDurationDays,
        airline: source.airline,
        airlineCode: source.airlineCode,
        routeFrom: source.routeFrom,
        routeTo: source.routeTo,
        heroDescription: source.heroDescription,
        inclusions: source.inclusions ?? [],
        exclusions: source.exclusions ?? [],
        trustBadges: source.trustBadges ?? null,
        kursiTotal: source.kursiTotal,
        kursiTerisi: 0,                   // always reset for the new trip
        manifestClosesAt: null,           // intentionally reset; admin picks per new departure
        komisiRate: source.komisiRate,    // carry the global rate; matrix copied below
        status: 'DRAFT',                  // always start in DRAFT — admin activates explicitly
        publishedAt: null,
        createdById: actor?.id ?? null,
        // Stage 34 — durable lineage column so the YoY leaderboard can
        // compare this clone against its parent without scraping AuditLog.
        clonedFromId: source.id,
      },
    });

    if (source.hotels.length > 0) {
      await tx.paketHotel.createMany({
        data: source.hotels.map((h) => ({
          paketId: created.id,
          city: h.city, name: h.name, stars: h.stars,
          nights: h.nights, distance: h.distance, description: h.description,
          order: h.order,
        })),
      });
    }
    if (source.days.length > 0) {
      await tx.paketDay.createMany({
        data: source.days.map((d) => ({
          paketId: created.id,
          dayNumber: d.dayNumber, dayRange: d.dayRange,
          dateLabel: d.dateLabel, monthLabel: d.monthLabel,
          title: d.title, description: d.description,
          tags: d.tags ?? null, highlight: d.highlight,
          pembimbingTitle: d.pembimbingTitle, pembimbingNote: d.pembimbingNote,
        })),
      });
    }
    if (source.prices.length > 0) {
      await tx.paketHarga.createMany({
        data: source.prices.map((p) => ({
          paketId: created.id,
          kelas: p.kelas, label: p.label, caption: p.caption,
          priceIdr: p.priceIdr, cicilanIdr: p.cicilanIdr, cicilanMonths: p.cicilanMonths,
          isFeatured: p.isFeatured,
        })),
      });
    }
    if (data.includeAgentOverrides && source.agentOverrides.length > 0) {
      await tx.agentPaketKomisi.createMany({
        data: source.agentOverrides.map((o) => ({
          agentId: o.agentId, paketId: created.id, rate: o.rate,
        })),
      });
    }

    return created;
  });

  await audit({
    req, actor,
    action: 'CREATE', entity: 'Paket', entityId: cloned.id,
    after: {
      slug: cloned.slug, title: cloned.title, status: cloned.status,
      cloned: true,
      clonedFromSlug: sourceSlug,
      hotelsCopied: source.hotels.length,
      daysCopied: source.days.length,
      pricesCopied: source.prices.length,
      agentOverridesCopied: data.includeAgentOverrides ? source.agentOverrides.length : 0,
    },
  });

  return cloned;
}

export async function softDeletePaket({ req, actor, slug }) {
  const before = await db.paket.findUnique({ where: { slug } });
  if (!before || before.deletedAt) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

  // Refuse if any active bookings exist (safety net)
  const liveBookings = await db.booking.count({
    where: { paketId: before.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
  });
  if (liveBookings > 0) {
    throw new HttpError(409,
      `Paket masih memiliki ${liveBookings} booking aktif — batalkan/refund dulu sebelum mengarsipkan`,
      'PAKET_HAS_BOOKINGS');
  }

  const archived = await db.paket.update({
    where: { id: before.id },
    data: { deletedAt: new Date(), status: 'ARCHIVED' },
  });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Paket', entityId: archived.id,
    before: { slug: before.slug, status: before.status },
    after: { deletedAt: archived.deletedAt },
  });
  return archived;
}
