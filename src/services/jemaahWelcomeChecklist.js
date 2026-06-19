// Stage 379 — Welcome checklist for new jemaah.
//
// Derived entirely from existing data — no schema migration. Four
// onboarding items that map to a complete-enough profile for booking
// + trip readiness:
//   1. Profil lengkap (NIK + birthDate + address)
//   2. Upload paspor (JemaahDocument type=PASSPORT with file attached)
//   3. Atur kontak darurat (JemaahProfile.emergencyContact)
//   4. Install PWA (CLIENT-SIDE check — see view)
//
// Returns null when called for non-JEMAAH user OR when jemaah has been
// registered > WELCOME_MAX_AGE_DAYS AND items are 100% complete — at
// that point the welcome card has served its purpose and shouldn't
// keep showing. The view also persists a dismiss flag in localStorage
// so jemaah who tap "✕" don't see the card again even if incomplete.

import { db } from '../lib/db.js';

const WELCOME_MAX_AGE_DAYS = 30;

export async function getJemaahWelcomeChecklist(userId) {
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true, createdAt: true,
      jemaah: {
        select: {
          id: true, nik: true, birthDate: true, address: true,
          emergencyContact: true,
          documents: {
            where: { type: 'PASSPORT' },
            select: { status: true, filePath: true, refNumber: true },
          },
        },
      },
    },
  });
  if (!user || user.role !== 'JEMAAH' || !user.jemaah) return null;

  const p = user.jemaah;
  // S379 — profile is "complete" when nik + birthDate + address all set.
  // Loose check: any non-empty value passes (admin or jemaah can fill via
  // /saya/profile).
  const profileDone = !!(p.nik && p.birthDate && p.address && String(p.address).trim().length > 0);
  // Paspor: any PASSPORT row with refNumber OR file attached. SUBMITTED /
  // VERIFIED are richer, but PENDING with file or refNumber means "I started"
  // — enough to mark the item done.
  const paspor = p.documents.find((d) => d.refNumber || d.filePath);
  const pasporDone = !!paspor;
  // Kontak darurat: anything truthy.
  const iceDone = !!(p.emergencyContact && String(p.emergencyContact).trim().length > 0);

  const items = [
    {
      key: 'profile',
      label: 'Lengkapi profil (NIK, tanggal lahir, alamat)',
      done: profileDone,
      link: '/saya/profile',
    },
    {
      key: 'passport',
      label: 'Tambahkan paspor (atau scan-nya)',
      done: pasporDone,
      link: '/saya/profile#docs',
    },
    {
      key: 'emergency',
      label: 'Isi kontak darurat (mahram/keluarga)',
      done: iceDone,
      link: '/saya/profile',
    },
    {
      key: 'pwa',
      label: 'Pasang Religio Pro sebagai aplikasi (PWA)',
      done: null, // client-side; view paints based on standalone display-mode
      link: null,
    },
  ];

  // Server-side score counts only items where done is known.
  const serverKnown = items.filter((i) => i.done !== null);
  const serverDone = serverKnown.filter((i) => i.done).length;

  // "Stale" once the account is older than the window — we still return
  // the checklist (caller decides whether to render) so analytics can see
  // who never finished onboarding.
  const ageMs = Date.now() - new Date(user.createdAt).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  const stale = ageDays > WELCOME_MAX_AGE_DAYS;

  return {
    items,
    serverDone,
    serverTotal: serverKnown.length,
    totalCount: items.length,
    ageDays,
    stale,
  };
}

export { WELCOME_MAX_AGE_DAYS };
