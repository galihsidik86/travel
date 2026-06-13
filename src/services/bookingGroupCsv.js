// Stage 261 — per-group CSV. Each row is one member booking + a TOTAL
// footer summing money. UTF-8 BOM + RFC 4180 quoting + CRLF (Excel
// mojibake-proof, matches the S138/S165/S168 convention).
function escape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; }
}

function numeric(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

export function buildGroupCsv(group) {
  if (!group) return '';
  const headers = [
    'Group Key', 'Group Label',
    'Booking No', 'Status', 'Kelas', 'PAX',
    'Jemaah', 'Phone', 'Email',
    'Paket Slug', 'Paket Title', 'Departure',
    'Agen Slug', 'Agen Nama',
    'Currency', 'Total', 'Paid', 'Balance',
    'Created',
  ];
  const lines = [headers.join(',')];

  let totalAmount = 0;
  let totalPaid = 0;
  let totalPax = 0;
  for (const m of group.members) {
    const total = numeric(m.totalAmount);
    const paid = numeric(m.paidAmount);
    totalAmount += total;
    totalPaid += paid;
    totalPax += m.paxCount || 0;
    const cells = [
      group.groupKey,
      group.label || '',
      m.bookingNo,
      m.status,
      m.kelas,
      m.paxCount,
      m.jemaah?.fullName || '',
      m.jemaah?.phone || '',
      m.jemaah?.email || '',
      m.paket?.slug || '',
      m.paket?.title || '',
      fmtDate(m.paket?.departureDate),
      m.agent?.slug || '',
      m.agent?.displayName || '',
      m.currency || 'IDR',
      total,
      paid,
      total - paid,
      fmtDate(m.createdAt),
    ];
    lines.push(cells.map(escape).join(','));
  }

  // TOTAL footer — sums money across all members for quick accounting check.
  const footer = [
    group.groupKey, group.label || '',
    'TOTAL', '', '', totalPax,
    `${group.members.length} jemaah`, '', '',
    '', '', '',
    '', '',
    group.members[0]?.currency || 'IDR',
    totalAmount, totalPaid, totalAmount - totalPaid,
    '',
  ];
  lines.push(footer.map(escape).join(','));

  return '\uFEFF' + lines.join('\r\n');
}
