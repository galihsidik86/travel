// Stage 307 — daily cron: send ulang-tahun greeting WA+EMAIL to jemaah
// whose birthDate matches today's month/day.
//
// **Once-per-year cooldown** via the Notification table — look back 360d
// for a prior BIRTHDAY_GREETING row keyed on `relatedEntityId=jemaahId`.
// A jemaah whose birthday is today AND who got a card this calendar year
// already is silently skipped (cron re-runs the same day → no spam).
//
// Engagement opt-out (S309) is enforced at the query level
// (`notifEngagement: true` on JemaahProfile) so opted-out jemaah never
// appear in the candidate list. This is cheaper than per-row checks at
// enqueue time + lets the candidate count honestly reflect intent.
//
// Per-channel opt-out (notifEmail/notifWa from 5jj) is left to
// `enqueueNotification` since those affect transactional notifs the
// same way.

import { db } from '../lib/db.js';

const COOLDOWN_DAYS = 360;

/**
 * Find jemaah whose birthDate matches today's month + day AND who haven't
 * received a birthday greeting in the last ~year. Returns full identity
 * fields for the caller to enqueue from.
 */
export async function getBirthdayCandidates({ now = new Date() } = {}) {
  const m = now.getMonth() + 1;
  const d = now.getDate();

  // Date math on a nullable column is awkward in Prisma; we pull all
  // jemaah with birthDate set + engagement opt-in, then filter in JS.
  // Volume is bounded by "active jemaah with birthDate today" which is
  // tiny (~1/365 of the base) — JS filter is fine.
  const rows = await db.jemaahProfile.findMany({
    where: {
      birthDate: { not: null },
      notifEngagement: true,
    },
    select: {
      id: true, fullName: true, phone: true, email: true,
      birthDate: true, userId: true,
    },
  });
  const todayMatches = rows.filter((j) => {
    const bd = j.birthDate;
    if (!bd) return false;
    return (bd.getMonth() + 1) === m && bd.getDate() === d;
  });
  if (todayMatches.length === 0) return [];

  // Cooldown — anyone who got BIRTHDAY_GREETING in the last 360d skips.
  const ids = todayMatches.map((j) => j.id);
  const cutoff = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000);
  const prior = await db.notification.findMany({
    where: {
      type: 'BIRTHDAY_GREETING',
      relatedEntity: 'JemaahProfile',
      relatedEntityId: { in: ids },
      createdAt: { gte: cutoff },
    },
    select: { relatedEntityId: true },
  });
  const sentRecently = new Set(prior.map((p) => p.relatedEntityId));
  return todayMatches.filter((j) => !sentRecently.has(j.id));
}

/**
 * Enqueue birthday greetings for every candidate. Fires BOTH EMAIL + WA
 * when contacts present (each respects per-channel opt-out internally).
 * **Silent on quiet days** — no candidates → no enqueues.
 */
export async function sendBirthdayGreetings({ now = new Date() } = {}) {
  const candidates = await getBirthdayCandidates({ now });
  if (candidates.length === 0) {
    return { candidateCount: 0, enqueued: 0, skipped: 0 };
  }
  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const j of candidates) {
    if (!j.email && !j.phone) { skipped += 1; continue; }
    const firstName = (j.fullName || 'Jemaah').split(/\s+/)[0];
    const subject = `Selamat ulang tahun, ${firstName} 🌙`;
    const body = [
      `Assalamu'alaikum ${j.fullName},`,
      '',
      'Selamat ulang tahun dari keluarga besar Religio Pro.',
      'Semoga Allah berkahi usia Anda dan mempermudah niat-niat baik Anda',
      'termasuk niat berziarah ke Baitullah dan al-Aqsa.',
      '',
      'Terima kasih telah menjadi bagian dari perjalanan kami.',
      '',
      '— Religio Pro',
    ].join('\n');
    for (const channel of ['EMAIL', 'WA']) {
      const recipient = channel === 'EMAIL'
        ? (j.email ? { recipientEmail: j.email } : null)
        : (j.phone ? { recipientPhone: j.phone } : null);
      if (!recipient) continue;
      try {
        const r = await enqueueNotification({
          type: 'BIRTHDAY_GREETING', channel,
          ...recipient,
          recipientUserId: j.userId || null,
          subject, body,
          payload: { kind: 'birthday_greeting', jemaahId: j.id },
          relatedEntity: 'JemaahProfile', relatedEntityId: j.id,
        });
        if (r && r.status !== 'SKIPPED') enqueued += 1;
        else skipped += 1;
      } catch (err) {
        console.warn(`[birthday] jemaah ${j.id} (${channel}) failed:`, err?.message || err);
        skipped += 1;
      }
    }
  }
  return { candidateCount: candidates.length, enqueued, skipped };
}

export { COOLDOWN_DAYS };
