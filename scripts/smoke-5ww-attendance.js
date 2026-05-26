// Smoke test for 5ww — crew attendance per-day.
//
// Covers:
//   1. listAttendanceDays null for unassigned crew + scoped to assigned paket
//   2. listAttendanceDays counts present marks correctly (ignores CANCELLED bookings)
//   3. getAttendanceGrid returns existing marks per booking
//   4. getAttendanceGrid null when day belongs to other paket (anti-enumeration)
//   5. setAttendanceMark upserts (idempotent re-mark, present toggle, notes preserved)
//   6. setAttendanceMark refuses for unassigned crew (404)
//   7. setAttendanceMark refuses when (dayId, bookingId) doesn't match paket
//   8. Composite unique (bookingId, paketDayId) — repeat upserts never double-row
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  assignCrewToPaket,
  listAttendanceDays, getAttendanceGrid, setAttendanceMark,
} from '../src/services/crewPortal.js';

const tag = `smoke5ww-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function mkUser(role, suffix) {
  const passwordHash = await hashPassword('smoke12345');
  return db.user.create({
    data: {
      email: `${tag}-${suffix}@example.test`, passwordHash, role,
      fullName: `Smoke ${suffix}`, phone: '+62811',
    },
  });
}
async function mkPaket(suffix) {
  const dep = new Date(Date.now() + 30 * 86_400_000);
  return db.paket.create({
    data: {
      slug: `5ww-${tag}-${suffix}`, title: `Paket ${suffix}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      days: {
        create: [
          { dayNumber: 1, title: 'Arrival', description: 'Land in Madinah' },
          { dayNumber: 2, title: 'Manasik', description: 'Practice rituals' },
        ],
      },
    },
    include: { days: { orderBy: { dayNumber: 'asc' } } },
  });
}
async function mkBooking(paketId, suffix, status = 'PENDING') {
  const jem = await db.jemaahProfile.create({
    data: { fullName: `Jemaah ${suffix}`, phone: '+62822' + suffix },
  });
  return db.booking.create({
    data: {
      bookingNo: `RP-${tag}-${suffix}`, paketId, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status,
    },
  });
}

async function main() {
  console.log(`\n[5ww smoke] tag=${tag}`);

  const crewA = await mkUser('MUTHAWWIF', 'mut-A');
  const crewB = await mkUser('MUTHAWWIF', 'mut-B');
  const paketA = await mkPaket('A');
  const paketB = await mkPaket('B');

  await assignCrewToPaket({
    req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null },
    paketSlug: paketA.slug, userId: crewA.id,
  });

  const day1 = paketA.days[0];
  const day2 = paketA.days[1];
  const otherDay = paketB.days[0];

  const bk1 = await mkBooking(paketA.id, '1');
  const bk2 = await mkBooking(paketA.id, '2');
  const bkCancelled = await mkBooking(paketA.id, 'X', 'CANCELLED');
  const bkOther = await mkBooking(paketB.id, 'Z'); // belongs to paketB

  // 1. Unassigned crew → null
  assert(await listAttendanceDays({ userId: crewB.id, slug: paketA.slug }) === null,
    'unassigned crew gets null for overview');
  assert(await getAttendanceGrid({ userId: crewB.id, slug: paketA.slug, dayId: day1.id }) === null,
    'unassigned crew gets null for grid');

  // Assigned crew gets data
  const overview = await listAttendanceDays({ userId: crewA.id, slug: paketA.slug });
  assert(overview, 'assigned crew sees overview');
  assert(overview.days.length === 2, '2 days in overview');
  assert(overview.totalActive === 2, 'totalActive excludes CANCELLED booking (bkCancelled)');
  assert(overview.days[0].presentCount === 0 && overview.days[0].markedCount === 0, 'fresh day has 0 marks');

  // Mark day1: bk1 present, bk2 absent with notes
  const ctx = (uid) => ({
    req: { ip: '127.0.0.1', headers: {} },
    actor: { id: uid, email: 'crew@test', role: 'MUTHAWWIF' },
    userId: uid,
  });
  await setAttendanceMark({
    ...ctx(crewA.id), slug: paketA.slug, dayId: day1.id, bookingId: bk1.id,
    present: true,
  });
  await setAttendanceMark({
    ...ctx(crewA.id), slug: paketA.slug, dayId: day1.id, bookingId: bk2.id,
    present: false, notes: 'Sakit, di hotel',
  });

  // 2. Overview reflects marks
  const overview2 = await listAttendanceDays({ userId: crewA.id, slug: paketA.slug });
  const d1 = overview2.days.find((d) => d.id === day1.id);
  assert(d1.presentCount === 1, '1 present after marks');
  assert(d1.markedCount === 2, '2 marked (1 present + 1 absent)');

  // 3. Grid has marks
  const grid = await getAttendanceGrid({ userId: crewA.id, slug: paketA.slug, dayId: day1.id });
  assert(grid.bookings.length === 2, 'grid has 2 active bookings (CANCELLED excluded)');
  const bk1Row = grid.bookings.find((b) => b.id === bk1.id);
  const bk2Row = grid.bookings.find((b) => b.id === bk2.id);
  assert(bk1Row.mark?.present === true, 'bk1 marked present');
  assert(bk2Row.mark?.present === false, 'bk2 marked absent');
  assert(bk2Row.mark?.notes === 'Sakit, di hotel', 'bk2 notes preserved');

  // 4. Day from other paket → null
  const wrongDay = await getAttendanceGrid({ userId: crewA.id, slug: paketA.slug, dayId: otherDay.id });
  assert(wrongDay === null, 'day from other paket → null (anti-enumeration)');

  // 5. Upsert idempotent — flip bk1 from present to absent, then back
  await setAttendanceMark({
    ...ctx(crewA.id), slug: paketA.slug, dayId: day1.id, bookingId: bk1.id,
    present: false, notes: 'Tertinggal di kamar',
  });
  const reFetch = await getAttendanceGrid({ userId: crewA.id, slug: paketA.slug, dayId: day1.id });
  const bk1AfterFlip = reFetch.bookings.find((b) => b.id === bk1.id);
  assert(bk1AfterFlip.mark.present === false, 'bk1 flipped to absent');
  assert(bk1AfterFlip.mark.notes === 'Tertinggal di kamar', 'notes updated on re-mark');

  // 8. Still only 1 row per (booking, day)
  const allMarksBk1 = await db.attendanceMark.count({ where: { bookingId: bk1.id, paketDayId: day1.id } });
  assert(allMarksBk1 === 1, 'composite unique respects re-mark (1 row only)');

  // 6. Unassigned crew can't set marks
  let unassignedBlocked = false;
  try {
    await setAttendanceMark({
      ...ctx(crewB.id), slug: paketA.slug, dayId: day1.id, bookingId: bk1.id, present: true,
    });
  } catch (e) { unassignedBlocked = e.code === 'NOT_ASSIGNED'; }
  assert(unassignedBlocked, 'unassigned crew refused (NOT_ASSIGNED)');

  // 7. (dayId, bookingId) tuple guard — cross-paket combinations refused
  let crossBookingBlocked = false;
  try {
    await setAttendanceMark({
      ...ctx(crewA.id), slug: paketA.slug, dayId: day1.id, bookingId: bkOther.id, present: true,
    });
  } catch (e) { crossBookingBlocked = e.code === 'NOT_FOUND'; }
  assert(crossBookingBlocked, 'booking from other paket refused');

  let crossDayBlocked = false;
  try {
    await setAttendanceMark({
      ...ctx(crewA.id), slug: paketA.slug, dayId: otherDay.id, bookingId: bk1.id, present: true,
    });
  } catch (e) { crossDayBlocked = e.code === 'NOT_FOUND'; }
  assert(crossDayBlocked, 'day from other paket refused');

  // Cleanup
  const allBookingIds = [bk1.id, bk2.id, bkCancelled.id, bkOther.id];
  const jemaahIds = (await db.booking.findMany({ where: { id: { in: allBookingIds } }, select: { jemaahId: true } })).map((b) => b.jemaahId);
  await db.attendanceMark.deleteMany({ where: { bookingId: { in: allBookingIds } } });
  await db.booking.deleteMany({ where: { id: { in: allBookingIds } } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: jemaahIds } } });
  await db.paketCrew.deleteMany({ where: { paketId: { in: [paketA.id, paketB.id] } } });
  await db.paketDay.deleteMany({ where: { paketId: { in: [paketA.id, paketB.id] } } });
  await db.paket.deleteMany({ where: { id: { in: [paketA.id, paketB.id] } } });
  await db.auditLog.deleteMany({ where: { actorEmail: { in: ['sys@test', 'crew@test'] } } });
  await db.user.deleteMany({ where: { id: { in: [crewA.id, crewB.id] } } });
  console.log('  cleanup done');

  console.log('\n[5ww smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5ww smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
