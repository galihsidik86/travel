// Stage 191 — manifest age-bracket counts. Compute jemaah age at
// paket departureDate; bucket into Anak / Dewasa / Lansia.
//
// Brackets (Indonesian convention):
//   - Anak:    < 12 years
//   - Dewasa:  12 - 59 years
//   - Lansia:  ≥ 60 years
//   - Unknown: birthDate null / unparseable
//
// Active bookings only (excludes CANCELLED/REFUNDED) — header KPI
// reflects "who's actually going". Lansia count is the operationally
// significant one (extra care during ihram, wheelchair, slower walks).

const ANAK_MAX_YEARS = 12;
const LANSIA_MIN_YEARS = 60;

/**
 * Compute years between birthDate and refDate.
 * Returns null when birthDate is missing/invalid.
 */
export function computeAge(birthDate, refDate) {
  if (!birthDate) return null;
  const b = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const ref = refDate instanceof Date ? refDate : new Date(refDate);
  if (Number.isNaN(ref.getTime())) return null;
  let years = ref.getFullYear() - b.getFullYear();
  // Subtract 1 when birthday hasn't occurred yet in refDate's year
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) {
    years -= 1;
  }
  return years;
}

/**
 * Given an array of bookings (each with `.jemaah.birthDate` + `.status`
 * + `.paxCount`) and a `departureDate`, return age-bracket totals.
 *
 * **paxCount-aware**: a 3-pax family booking with jemaah birthDate
 * (assumed the lead jemaah) counts as 3 toward the bracket — the
 * additional family members share the lead's row in the system since
 * we don't have individual birthDate per pax. This is an approximation
 * but matches the existing manifest convention of "one row per booking".
 */
export function computeAgeBuckets({ bookings, departureDate }) {
  let anak = 0, dewasa = 0, lansia = 0, unknown = 0;
  for (const b of bookings) {
    if (!b || b.status === 'CANCELLED' || b.status === 'REFUNDED') continue;
    const pax = b.paxCount || 1;
    const age = computeAge(b.jemaah?.birthDate, departureDate);
    if (age == null) unknown += pax;
    else if (age < ANAK_MAX_YEARS) anak += pax;
    else if (age >= LANSIA_MIN_YEARS) lansia += pax;
    else dewasa += pax;
  }
  return { anak, dewasa, lansia, unknown, total: anak + dewasa + lansia + unknown };
}

export { ANAK_MAX_YEARS, LANSIA_MIN_YEARS };
