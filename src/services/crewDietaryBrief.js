// Stage 213 — crew dietary brief. Monday morning email per assigned
// crew with a soon-departing paket (default within 14 days). Lists
// every non-REGULAR jemaah on the paket so muthawwif can hand the
// roll-up to the hotel kitchen on arrival.
//
// Mirrors the S65 weekly digest pattern: per-crew iteration with
// per-row failure isolation in the batch entry. Skips silently when
// no crew has a near-departure paket with special diets — no point
// emailing "everyone is REGULAR".

import { db } from '../lib/db.js';
import { enqueueNotification, dispatchNotification } from './notifications.js';

const DIETARY_LABELS = {
  REGULAR: 'Reguler',
  VEGETARIAN: 'Vegetarian',
  HALAL_STRICT: 'Halal ketat',
  SOFT_TEXTURE: 'Tekstur lembut (lansia)',
  DIABETIC: 'Diabetes (rendah gula)',
  OTHER: 'Lainnya',
};

/**
 * Returns array of { user, paket, specials[], tally } for every ACTIVE
 * MUTHAWWIF assigned to a paket departing in [now, now + windowDays].
 * Crew with multiple paket in window get multiple entries (one brief
 * per paket — keep emails focused).
 *
 * `specials` excludes REGULAR (silent default — kitchen only cares
 * about the exceptions). `tally` counts per-category pax across ALL
 * jemaah on the paket so the brief shows the full denominator.
 */
export async function getCrewDietaryBriefCandidates({ now = new Date(), windowDays = 14 } = {}) {
  const cutoff = new Date(now.getTime() + windowDays * 86_400_000);

  // Find ACTIVE non-deleted crew assignments whose paket departs in window
  const assignments = await db.paketCrew.findMany({
    where: {
      user: { role: 'MUTHAWWIF', status: 'ACTIVE', deletedAt: null },
      paket: {
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        departureDate: { gte: now, lte: cutoff },
      },
    },
    select: {
      paketId: true,
      user: { select: { id: true, fullName: true, email: true } },
      paket: {
        select: {
          id: true, slug: true, title: true, departureDate: true,
          bookings: {
            where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
            select: {
              id: true, bookingNo: true, kelas: true, paxCount: true,
              jemaah: {
                select: {
                  fullName: true, phone: true,
                  dietary: true, dietaryNotes: true,
                },
              },
              room: { select: { roomNo: true } },
            },
          },
        },
      },
    },
  });

  const out = [];
  for (const a of assignments) {
    const bookings = a.paket.bookings || [];
    const tally = new Map();
    for (const b of bookings) {
      const d = b.jemaah?.dietary || 'REGULAR';
      tally.set(d, (tally.get(d) || 0) + (b.paxCount || 1));
    }
    const specials = bookings
      .filter((b) => (b.jemaah?.dietary || 'REGULAR') !== 'REGULAR')
      .sort((x, y) => {
        const dx = x.jemaah.dietary || '';
        const dy = y.jemaah.dietary || '';
        if (dx !== dy) return dx.localeCompare(dy);
        return (x.jemaah.fullName || '').localeCompare(y.jemaah.fullName || '');
      });
    out.push({
      user: a.user,
      paket: { id: a.paket.id, slug: a.paket.slug, title: a.paket.title, departureDate: a.paket.departureDate },
      specials,
      tally: Object.fromEntries(tally),
      totalPax: bookings.reduce((acc, b) => acc + (b.paxCount || 1), 0),
      specialPax: specials.reduce((acc, b) => acc + (b.paxCount || 1), 0),
    });
  }
  return out;
}

/**
 * Build subject + body text. Public so tests can verify shape without
 * touching the notification queue.
 */
export function formatDietaryBrief({ user, paket, specials, tally, totalPax, specialPax }) {
  const dep = paket.departureDate
    ? new Date(paket.departureDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'TBA';
  const subject = `[Dietary] ${paket.title} (berangkat ${dep})`;
  const tallyLine = Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const linesByCategory = new Map();
  for (const b of specials) {
    const d = b.jemaah.dietary;
    if (!linesByCategory.has(d)) linesByCategory.set(d, []);
    linesByCategory.get(d).push(
      `  · ${b.jemaah.fullName}${b.room?.roomNo ? ` (kamar ${b.room.roomNo})` : ''}${
        b.jemaah.dietaryNotes ? ` — ${b.jemaah.dietaryNotes}` : ''
      }`,
    );
  }
  const sections = [...linesByCategory.entries()].map(([code, lines]) => {
    const label = DIETARY_LABELS[code] || code;
    return `${code} — ${label} (${lines.length} jemaah):\n${lines.join('\n')}`;
  });
  const body = [
    `Halo ${user.fullName || 'Muthawwif'},`,
    '',
    `Paket "${paket.title}" berangkat ${dep}.`,
    `Total jemaah: ${totalPax} pax · diet khusus: ${specialPax} pax.`,
    `Roll-up: ${tallyLine || 'tidak ada'}`,
    '',
    'Daftar diet khusus (untuk brief ke kitchen hotel):',
    '',
    sections.join('\n\n'),
    '',
    'Cetak/screenshot email ini untuk dibawa ke restoran hotel.',
    '— Religio Pro',
  ].join('\n');
  return { subject, body };
}

/**
 * Enqueue ONE EMAIL per (crew × paket). Skips when crew has no email
 * (no point queueing) AND when there are zero specials (silent on
 * all-REGULAR paket — kitchen brief carries no signal).
 */
export async function notifyCrewDietaryBrief(candidate) {
  if (!candidate?.user?.email) return { skipped: true, reason: 'no_email' };
  if (!candidate.specials || candidate.specials.length === 0) {
    return { skipped: true, reason: 'all_regular' };
  }
  const { subject, body } = formatDietaryBrief(candidate);
  try {
    const notif = await enqueueNotification({
      type: 'CREW_DIETARY_BRIEF',
      channel: 'EMAIL',
      recipientEmail: candidate.user.email,
      recipientUserId: candidate.user.id,
      subject,
      body,
      payload: {
        paketId: candidate.paket.id,
        paketSlug: candidate.paket.slug,
        specialCount: candidate.specials.length,
        tally: candidate.tally,
      },
      relatedEntity: 'Paket',
      relatedEntityId: candidate.paket.id,
    });
    return { enqueued: true, notifId: notif?.id };
  } catch (err) {
    return { skipped: true, reason: 'enqueue_failed', error: err?.message || String(err) };
  }
}

/**
 * Batch entry. Iterates every candidate, catches per-row failures so a
 * bad crew/paket combo doesn't abort the whole run. Returns counters
 * so the cron logs a clean summary.
 */
export async function sendCrewDietaryBriefs({ now = new Date(), windowDays = 14 } = {}) {
  const candidates = await getCrewDietaryBriefCandidates({ now, windowDays });
  let enqueued = 0;
  let skippedNoEmail = 0;
  let skippedAllRegular = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      const r = await notifyCrewDietaryBrief(c);
      if (r.enqueued) {
        enqueued += 1;
        // Best-effort dispatch attempt right away so test/dev sees the row resolve.
        try {
          await dispatchNotification(r.notifId);
        } catch {
          /* ignored */
        }
      } else if (r.reason === 'no_email') skippedNoEmail += 1;
      else if (r.reason === 'all_regular') skippedAllRegular += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.warn('[crewDietaryBrief]', c?.user?.email, err?.message || err);
    }
  }
  return {
    candidates: candidates.length,
    enqueued,
    skippedNoEmail,
    skippedAllRegular,
    failed,
  };
}
