// Stage 208 — per-paket pickup roster CSV. Bus drivers download this
// to verify who they're picking up at each location. One CSV with
// per-row pickup label so a driver can filter / sort in Excel; rows
// grouped by pickup (sortOrder), then by jemaah name.
//
// Optional `?pickupId=<id>` query narrows to ONE pickup (a single
// driver only wants their route); `'__TBD__'` filters to bookings
// without a pickup choice yet.
//
// Excludes CANCELLED/REFUNDED bookings (those aren't being picked up).
// UTF-8 BOM + RFC 4180 quoting + CRLF — matches the S138/S165/S168
// CSV convention so Excel reads it cleanly.

import { db } from '../lib/db.js';

function esc(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function buildPickupRosterCsv(paketSlug, { pickupId = null } = {}) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: { id: true, slug: true, title: true, departureDate: true },
  });
  if (!paket) return null;

  // Build booking filter — narrow to one pickup when requested
  const where = {
    paketId: paket.id,
    status: { notIn: ['CANCELLED', 'REFUNDED'] },
  };
  if (pickupId === '__TBD__') where.pickupId = null;
  else if (pickupId) where.pickupId = pickupId;

  const bookings = await db.booking.findMany({
    where,
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true, status: true,
      pickup: { select: { id: true, label: true, address: true, departTime: true, sortOrder: true } },
      jemaah: {
        select: {
          fullName: true, phone: true, nik: true,
          emergencyContact: true,
        },
      },
      room: { select: { roomNo: true } },
    },
  });

  // Sort: pickup sortOrder asc (TBD last), then jemaah name within pickup
  bookings.sort((a, b) => {
    const aSort = a.pickup?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bSort = b.pickup?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (aSort !== bSort) return aSort - bSort;
    // TBD always last
    if (!a.pickup && b.pickup) return 1;
    if (a.pickup && !b.pickup) return -1;
    return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
  });

  const header = [
    'pickup', 'departTime', 'address',
    'bookingNo', 'jemaahName', 'phone', 'nik',
    'emergencyContact', 'kelas', 'paxCount', 'roomNo', 'status',
  ];
  const lines = bookings.map((b) => [
    b.pickup?.label || 'TBD',
    b.pickup?.departTime || '',
    b.pickup?.address || '',
    b.bookingNo,
    b.jemaah.fullName,
    b.jemaah.phone || '',
    b.jemaah.nik || '',
    b.jemaah.emergencyContact || '',
    b.kelas,
    b.paxCount,
    b.room?.roomNo || '',
    b.status,
  ].map(esc).join(','));

  // Footer count summary (per-pickup counts)
  const perPickup = new Map();
  for (const b of bookings) {
    const key = b.pickup?.label || 'TBD';
    perPickup.set(key, (perPickup.get(key) || 0) + b.paxCount);
  }
  const summary = [...perPickup.entries()]
    .map(([label, count]) => `${label}=${count}`)
    .join('; ');
  const footer = [
    '', '', '', '', 'TOTAL', '', '', '',
    '', String(bookings.reduce((acc, b) => acc + b.paxCount, 0)),
    '', summary,
  ].map(esc).join(',');

  const csv = ['\ufeff' + header.join(','), ...lines, footer].join('\r\n');
  return {
    csv, paket,
    rowCount: bookings.length,
    pickupFilter: pickupId || null,
  };
}
