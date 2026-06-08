// Stage 72 — generate VCALENDAR (.ics) payload for a booking. Drops the
// departure + return into the jemaah's phone calendar so they don't need
// to remember dates manually.
//
// Reference: RFC 5545. We emit a minimal VCALENDAR with one VEVENT
// covering departure → return, all-day. Inline description carries the
// booking ref + paket title + hotel summary so the calendar view shows
// useful context.

import { getMyBooking } from './jemaahPortal.js';

function pad2(n) { return String(n).padStart(2, '0'); }
function dateAllDay(d) {
  // VALUE=DATE format: YYYYMMDD (all-day event)
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}
function dateTimeUtc(d) {
  // VALUE=DATE-TIME UTC: YYYYMMDDTHHMMSSZ
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
    + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}

/**
 * Escape per RFC 5545: backslash, semicolon, comma, newline.
 */
function escapeIcsText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold long lines per RFC 5545 (>75 octets → CRLF + space continuation).
 * Conservative: split at 70 chars to be safe with multi-byte UTF-8.
 */
function foldLine(line) {
  if (line.length <= 70) return line;
  const chunks = [];
  for (let i = 0; i < line.length; i += 70) {
    chunks.push(line.slice(i, i + 70));
  }
  return chunks.join('\r\n ');
}

export async function generateBookingIcs({ userId, bookingId, now = new Date() }) {
  const booking = await getMyBooking(userId, bookingId);
  if (!booking) return null;
  if (!booking.paket?.departureDate || !booking.paket?.returnDate) return null;

  // Build the VEVENT body. End date in DTEND is exclusive per spec, so we
  // add one day to returnDate.
  const dep = new Date(booking.paket.departureDate);
  const ret = new Date(booking.paket.returnDate);
  const dtEnd = new Date(ret.getTime() + 86_400_000);

  const summary = `🕋 ${booking.paket.title}`;
  const descParts = [
    `Booking ${booking.bookingNo}`,
    `Kelas ${booking.kelas} · ${booking.paxCount} pax`,
    booking.paket.airline ? `Maskapai ${booking.paket.airline}` : null,
    booking.paket.routeFrom && booking.paket.routeTo
      ? `Rute ${booking.paket.routeFrom} → ${booking.paket.routeTo}`
      : null,
    `Detail: https://religio.pro/saya/bookings/${booking.id}`,
  ].filter(Boolean).join('\n');

  // Stable UID = bookingId@religio-pro (so calendar app updates the event
  // if user re-imports rather than creating duplicates)
  const uid = `${booking.id}@religio-pro`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Religio Pro//Booking Calendar//ID',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dateTimeUtc(now)}`,
    `DTSTART;VALUE=DATE:${dateAllDay(dep)}`,
    `DTEND;VALUE=DATE:${dateAllDay(dtEnd)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(descParts)}`,
    booking.paket.routeTo ? `LOCATION:${escapeIcsText(booking.paket.routeTo)}` : null,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    // Pre-departure reminder — 3 days before
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-P3D',
    `DESCRIPTION:${escapeIcsText('Persiapan keberangkatan ' + booking.paket.title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  const folded = lines.map(foldLine).join('\r\n') + '\r\n';

  return {
    filename: `religio-${booking.bookingNo}.ics`,
    body: folded,
  };
}
