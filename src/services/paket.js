import { db } from '../lib/db.js';

const HOTEL_CITY_ORDER = { MADINAH: 1, MEKKAH: 2, JEDDAH: 3, AQSA: 4, AMMAN: 5, PETRA: 6, ISTANBUL: 7, CAIRO: 8, DUBAI: 9, JAKARTA: 10 };
const KELAS_ORDER = { QUAD: 1, TRIPLE: 2, DOUBLE: 3, VVIP: 4 };

/**
 * Fetch an active paket by slug, with hotels/prices/days sorted for display.
 * Returns null if not found, draft, or archived/deleted.
 */
export async function getPaketBySlug(slug) {
  const paket = await db.paket.findFirst({
    where: {
      slug,
      deletedAt: null,
      status: { in: ['ACTIVE', 'CLOSED'] },
    },
    include: {
      hotels: true,
      prices: true,
      days: true,
    },
  });
  if (!paket) return null;

  paket.hotels.sort((a, b) => {
    const c = (HOTEL_CITY_ORDER[a.city] ?? 99) - (HOTEL_CITY_ORDER[b.city] ?? 99);
    return c !== 0 ? c : a.order - b.order;
  });
  paket.prices.sort((a, b) => (KELAS_ORDER[a.kelas] ?? 99) - (KELAS_ORDER[b.kelas] ?? 99));
  paket.days.sort((a, b) => a.dayNumber - b.dayNumber);

  return paket;
}

/**
 * Resolve an agent from the ?a=<slug> URL param. Returns null if not found.
 * Quietly tolerant — never throws.
 */
export async function getAgentBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;
  try {
    return await db.agentProfile.findUnique({
      where: { slug: normalized },
      include: { user: { select: { fullName: true, email: true } } },
    });
  } catch {
    return null;
  }
}

/**
 * Find a price row for a paket by kelas, returns the Decimal price or null.
 */
export function findPrice(paket, kelas) {
  return paket.prices.find((p) => p.kelas === kelas) ?? null;
}
