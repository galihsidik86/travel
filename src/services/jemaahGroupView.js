// Stage 264 — jemaah-side group view. Surfaces the S260 label + a
// privacy-sanitized sibling list on /saya/bookings/:id so a family
// booking feels cohesive.
//
// Privacy sanitization (this is jemaah-facing, not admin):
//   - NO admin-facing fields: status pills hide CANCELLED/REFUNDED rows
//     entirely (other family don't need to see "uncle dropped out"
//     unless it was their own booking)
//   - NO money: jemaah seeing their sibling's totalAmount is uncomfortable
//   - NO booking notes / tags / internal labels
//   - First-name only (display "Pak Ahmad" → "Ahmad" is enough for "yes
//     that's my dad"); strips honorifics + truncates to first space token
//   - NO email/phone — if the jemaah needs to contact sibling, they
//     already know each other (family group)
//
// Returns null when the booking has no groupKey OR group has no other
// active members — caller renders nothing.

import { db } from '../lib/db.js';

const HONORIFICS = new Set(['BAPAK', 'PAK', 'IBU', 'BU', 'HJ', 'H', 'KH', 'USTADZ', 'USTADZAH']);

function firstName(fullName) {
  if (!fullName) return '—';
  // Strip honorific prefix, then take first token.
  const tokens = String(fullName).trim().split(/\s+/);
  while (tokens.length > 0 && HONORIFICS.has(tokens[0].toUpperCase().replace(/\./g, ''))) {
    tokens.shift();
  }
  return tokens[0] || fullName;
}

export async function getJemaahGroupView({ groupKey, currentBookingId }) {
  if (!groupKey) return null;

  const [members, meta] = await Promise.all([
    db.booking.findMany({
      where: {
        groupKey,
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, paxCount: true, kelas: true,
        jemaah: { select: { fullName: true } },
      },
    }),
    db.bookingGroup.findUnique({
      where: { groupKey },
      select: { label: true },
    }),
  ]);

  // Exclude the viewer's own booking from the sibling count; if no
  // siblings remain after that, return null (panel hides). Single-member
  // groups are useless to the viewer.
  const siblings = members
    .filter((m) => m.id !== currentBookingId)
    .map((m) => ({
      // NO id leaked — siblings can't navigate to other people's bookings.
      firstName: firstName(m.jemaah?.fullName),
      paxCount: m.paxCount,
      kelas: m.kelas,
    }));
  if (siblings.length === 0) return null;

  return {
    groupKey,
    label: meta?.label || null,
    siblings,
    siblingCount: siblings.length,
    totalActiveMembers: members.length,
  };
}

// Exported helper for tests
export { firstName };
