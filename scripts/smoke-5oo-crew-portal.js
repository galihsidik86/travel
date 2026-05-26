// Smoke test for 5oo — crew (muthawwif) portal.
//
// Verifies:
//   1. assignCrewToPaket refuses non-MUTHAWWIF roles
//   2. assignCrewToPaket is idempotent (upsert — double-assign is no-op)
//   3. listAssignedPaket returns only assigned paket, sorted by departureDate asc
//   4. getAssignedManifest returns null when crew isn't assigned to that paket
//      (so the route can 404 without leakage)
//   5. getAssignedManifest excludes CANCELLED/REFUNDED bookings, includes docPills
//   6. ARCHIVED + soft-deleted paket filtered out of dashboard
//   7. unassignCrewFromPaket removes the row
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  assignCrewToPaket, unassignCrewFromPaket,
  listAssignedPaket, getAssignedManifest,
  listAvailableCrew, listAssignedCrewForPaket,
} from '../src/services/crewPortal.js';

const tag = `smoke5oo-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function makePaket(suffix, opts = {}) {
  const departure = new Date(Date.now() + (opts.daysOut || 30) * 86_400_000);
  return db.paket.create({
    data: {
      slug: `${tag}-${suffix}`, title: `Paket ${suffix}`,
      departureDate: departure, returnDate: new Date(departure.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0,
      status: opts.status || 'ACTIVE',
      deletedAt: opts.deletedAt || null,
    },
  });
}
async function makeUser(role, suffix) {
  const passwordHash = await hashPassword('smoke12345');
  return db.user.create({
    data: {
      email: `${tag}-${suffix}@example.test`, passwordHash, role,
      fullName: `Smoke ${suffix}`, phone: '+628111111111',
    },
  });
}

async function main() {
  console.log(`\n[5oo smoke] tag=${tag}`);

  const muthawwifA = await makeUser('MUTHAWWIF', 'mut-A');
  const muthawwifB = await makeUser('MUTHAWWIF', 'mut-B');
  const wrongRole = await makeUser('JEMAAH', 'jem');
  const paketSoon  = await makePaket('soon',  { daysOut: 10 });
  const paketLater = await makePaket('later', { daysOut: 60 });
  const paketOther = await makePaket('other', { daysOut: 30 });
  const paketArchived = await makePaket('arch', { daysOut: 20, status: 'ARCHIVED' });
  const paketSoftDel  = await makePaket('del',  { daysOut: 20, deletedAt: new Date() });
  // Audit actor: no id (avoids FK to User), no role (system convention from CLAUDE.md)
  const ctx = { req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null } };

  // 1. Non-MUTHAWWIF rejected
  let badRoleBlocked = false;
  try {
    await assignCrewToPaket({ ...ctx, paketSlug: paketSoon.slug, userId: wrongRole.id });
  } catch (e) { badRoleBlocked = e.code === 'BAD_ROLE'; }
  assert(badRoleBlocked, 'BAD_ROLE blocks JEMAAH from being assigned as crew');

  // 2. Assign A to two paket (soon + later), and B to other only
  await assignCrewToPaket({ ...ctx, paketSlug: paketSoon.slug, userId: muthawwifA.id });
  await assignCrewToPaket({ ...ctx, paketSlug: paketLater.slug, userId: muthawwifA.id });
  await assignCrewToPaket({ ...ctx, paketSlug: paketOther.slug, userId: muthawwifB.id });

  // Idempotent upsert: re-assign same pair → no error, no second row
  await assignCrewToPaket({ ...ctx, paketSlug: paketSoon.slug, userId: muthawwifA.id });
  const aCount = await db.paketCrew.count({ where: { userId: muthawwifA.id } });
  assert(aCount === 2, 'double-assign idempotent (still 2 rows for A)');

  // 3. listAssignedPaket scopes correctly + orders by departure asc
  const aList = await listAssignedPaket(muthawwifA.id);
  assert(aList.length === 2, 'A sees 2 paket');
  assert(aList[0].slug === paketSoon.slug, 'sooner trip first');
  assert(aList[1].slug === paketLater.slug, 'later trip second');

  const bList = await listAssignedPaket(muthawwifB.id);
  assert(bList.length === 1 && bList[0].slug === paketOther.slug, 'B scoped to own paket only');

  // 6. Archived + soft-deleted excluded — assign A to those, list should still skip
  await assignCrewToPaket({ ...ctx, paketSlug: paketArchived.slug, userId: muthawwifA.id });
  // soft-deleted: need to use raw create since the helper rejects deleted paket?
  // Actually assignCrewToPaket doesn't check deletedAt — assignment OK but listAssignedPaket filters
  await db.paketCrew.create({ data: { paketId: paketSoftDel.id, userId: muthawwifA.id } });
  const aListAfter = await listAssignedPaket(muthawwifA.id);
  assert(aListAfter.length === 2, 'ARCHIVED + soft-deleted paket excluded from list');
  assert(!aListAfter.some((p) => p.slug === paketArchived.slug), 'archived not in list');
  assert(!aListAfter.some((p) => p.slug === paketSoftDel.slug), 'soft-deleted not in list');

  // 4. Manifest scoping: A cannot see B's paket
  const wrongManifest = await getAssignedManifest({ userId: muthawwifA.id, slug: paketOther.slug });
  assert(wrongManifest === null, 'manifest returns null for unassigned paket (404 path)');

  // 5. Real manifest of an assigned paket — add bookings + jemaah w/ docs
  const jemaah1 = await db.jemaahProfile.create({
    data: { fullName: 'Test Jemaah 1', phone: '+628222222222' },
  });
  const jemaah2 = await db.jemaahProfile.create({
    data: { fullName: 'Test Jemaah 2', phone: '+628333333333' },
  });
  const bk1 = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paketSoon.id, jemaahId: jemaah1.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paketSoon.id, jemaahId: jemaah2.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
    },
  });
  // doc for jemaah1: 1 VERIFIED, 1 SUBMITTED
  await db.jemaahDocument.create({ data: { jemaahId: jemaah1.id, type: 'PASSPORT', status: 'VERIFIED', submittedAt: new Date(), verifiedAt: new Date() } });
  await db.jemaahDocument.create({ data: { jemaahId: jemaah1.id, type: 'VISA_UMROH', status: 'SUBMITTED', submittedAt: new Date() } });

  const manifest = await getAssignedManifest({ userId: muthawwifA.id, slug: paketSoon.slug });
  assert(manifest !== null, 'manifest returned for assigned paket');
  assert(manifest.bookings.length === 1, 'CANCELLED booking excluded from manifest');
  assert(manifest.bookings[0].bookingNo === bk1.bookingNo, 'right booking surfaces');
  const pills = manifest.bookings[0].docPills;
  const passportPill = pills.find((p) => p.type === 'PASSPORT');
  assert(passportPill && passportPill.state === 'verified', 'docPills compute for booking');
  assert(pills.length === 5, 'docPills returns 5 curated types');
  const missing = pills.find((p) => p.type === 'VACCINE_MENINGITIS');
  assert(missing && missing.state === 'missing', 'unsubmitted doc reads as missing');
  // Crew must NOT see money fields
  assert(!('totalAmount' in manifest.bookings[0]), 'no totalAmount in crew manifest');
  assert(!('paidAmount' in manifest.bookings[0]), 'no paidAmount in crew manifest');

  // 7. Admin helpers
  const all = await listAvailableCrew();
  assert(all.find((u) => u.id === muthawwifA.id), 'listAvailableCrew includes A');
  assert(!all.find((u) => u.id === wrongRole.id), 'listAvailableCrew excludes non-MUTHAWWIF');

  const assigned = await listAssignedCrewForPaket(paketSoon.slug);
  assert(assigned.length === 1 && assigned[0].id === muthawwifA.id, 'listAssignedCrewForPaket scoped');

  // 8. Unassign + verify gone
  await unassignCrewFromPaket({ ...ctx, paketSlug: paketSoon.slug, userId: muthawwifA.id });
  const after = await listAssignedCrewForPaket(paketSoon.slug);
  assert(after.length === 0, 'unassign removes the row');
  const aListFinal = await listAssignedPaket(muthawwifA.id);
  assert(!aListFinal.some((p) => p.slug === paketSoon.slug), 'A no longer sees paketSoon');

  // Cleanup
  await db.jemaahDocument.deleteMany({ where: { jemaahId: { in: [jemaah1.id, jemaah2.id] } } });
  await db.booking.deleteMany({ where: { paketId: { in: [paketSoon.id, paketLater.id, paketOther.id, paketArchived.id, paketSoftDel.id] } } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [jemaah1.id, jemaah2.id] } } });
  await db.paketCrew.deleteMany({ where: { userId: { in: [muthawwifA.id, muthawwifB.id] } } });
  await db.paket.deleteMany({ where: { id: { in: [paketSoon.id, paketLater.id, paketOther.id, paketArchived.id, paketSoftDel.id] } } });
  await db.auditLog.deleteMany({ where: { actorEmail: 'sys@test' } });
  await db.user.deleteMany({ where: { id: { in: [muthawwifA.id, muthawwifB.id, wrongRole.id] } } });
  console.log('  cleanup done');

  console.log('\n[5oo smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5oo smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
