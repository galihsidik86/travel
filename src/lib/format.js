// ============================================================
// Display formatters — locale id-ID, currency IDR.
// Used by EJS templates via res.locals.fmt.
// ============================================================

const ID_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];

/**
 * "62 Jt", "5,17 Jt", "312 Jt", "1,2 M"  (no Rp prefix — caller decides).
 * Accepts number, string, or Prisma Decimal (.toString() → "62000000").
 */
export function formatRpShort(amount) {
  const n = toNumber(amount);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    return trimZero((n / 1_000_000_000).toFixed(2)).replace('.', ',') + ' M';
  }
  if (abs >= 1_000_000) {
    return trimZero((n / 1_000_000).toFixed(2)).replace('.', ',') + ' Jt';
  }
  if (abs >= 1_000) {
    return trimZero((n / 1_000).toFixed(1)).replace('.', ',') + ' rb';
  }
  return String(n);
}

/**
 * Full "Rp 62.000.000" (Indonesian dot grouping).
 */
export function formatRpFull(amount) {
  const n = toNumber(amount);
  if (n == null) return '—';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

/** "25 Mar 2026" */
export function formatDate(dateLike) {
  const d = toDate(dateLike);
  if (!d) return '—';
  return `${d.getDate()} ${ID_MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** "25 Mar" */
export function formatDateShort(dateLike) {
  const d = toDate(dateLike);
  if (!d) return '—';
  return `${d.getDate()} ${ID_MONTH_SHORT[d.getMonth()]}`;
}

/** "21 Februari 2026" — used for closing-manifest copy */
export function formatDateLong(dateLike) {
  const d = toDate(dateLike);
  if (!d) return '—';
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Render-safe number for fields like priceIdr (Prisma Decimal).
 * Returns null for null/undefined.
 */
export function toNumber(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof x === 'bigint') return Number(x);
  if (typeof x?.toString === 'function') {
    const n = Number(x.toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toDate(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function trimZero(s) {
  // "5.10" → "5.1", "5.00" → "5", "5.17" stays
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

// Bundle for res.locals
export const fmt = { rpShort: formatRpShort, rpFull: formatRpFull, date: formatDate, dateShort: formatDateShort, dateLong: formatDateLong };
