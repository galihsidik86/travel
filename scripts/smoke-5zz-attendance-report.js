// Smoke test for 5zz — admin attendance report.
//
// Covers:
//   1. getPaketAttendanceReport returns null for missing/soft-deleted paket
//   2. Empty paket (no marks) → all counts zero, rate 0
//   3. Per-day counts roll up correctly across multiple bookings
//   4. Per-jemaah counts roll up correctly across multiple days
//   5. CANCELLED bookings excluded from both rollups
//   6. attendanceRatePct math: daysPresent / totalDays * 100 (rounded)
//   7. totalDays = paket.days.length, totalActive = active booking count
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { getPaketAttendanceReport } from '../src/services/crewPortal.js';

const tag = `smoke5zz-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log(`\n[5zz smoke] tag=${tag}`);

  // 1. Missing paket → null
  assert(await getPaketAttendanceReport(`${tag}-nope`) === null, 'missing slug → null');

  // 2. Soft-deleted paket → null
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const softDel = await db.paket.create({
    data: {
      slug: `5zz-del-${tag}`, title: 'Deleted',
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE', deletedAt: new Date(),
    },
  });
  assert(await getPaketAttendanceReport(softDel.slug) === null, 'soft-deleted → null');

  // 3. Build a paket with 3 itinerary days + 3 bookings (2 active + 1 cancelled)
  const paket = await db.paket.create({
    data: {
      slug: `5zz-${tag}`, title: 'Paket 5zz',
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      days: { create: [
        { dayNumber: 1, title: 'Arrival', description: 'Land' },
        { dayNumber: 2, title: 'Manasik', description: 'Practice' },
        { dayNumber: 3, title: 'Umrah', description: 'Tawaf + Sai' },
      ] },
    },
    include: { days: { orderBy: { dayNumber: 'asc' } } },
  });
  const [d1, d2, d3] = paket.days;

  // 2 active jemaah + 1 cancelled (cancelled should be excluded)
  const jemA = await db.jemaahProfile.create({ data: { fullName: 'Jemaah A', phone: '+62811A' } });
  const jemB = await db.jemaahProfile.create({ data: { fullName: 'Jemaah B', phone: '+62811B' } });
  const jemX = await db.jemaahProfile.create({ data: { fullName: 'Cancelled', phone: '+62811X' } });

  const bkA = await db.booking.create({ data: {
    bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: jemA.id,
    kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'DP_PAID',
  } });
  const bkB = await db.booking.create({ data: {
    bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: jemB.id,
    kelas: 'TRIPLE', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
  } });
  const bkX = await db.booking.create({ data: {
    bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: jemX.id,
    kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
  } });

  // Need a user for AttendanceMark.markedBy FK
  const crew = await db.user.create({
    data: {
      email: `${tag}-crew@example.test`, passwordHash: await hashPassword('x'),
      role: 'MUTHAWWIF', fullName: 'Crew', phone: '+628',
    },
  });

  // 2. Empty report (no marks yet)
  const empty = await getPaketAttendanceReport(paket.slug);
  assert(empty.totalActive === 2, 'CANCELLED excluded from totalActive');
  assert(empty.totalDays === 3, 'totalDays = 3 itinerary days');
  assert(empty.days.every((d) => d.presentCount === 0 && d.markedCount === 0), 'no marks yet');
  assert(empty.bookings.every((b) => b.attendanceRatePct === 0), 'rate 0 with no marks');

  // 5. Mark some attendance:
  //   - Day 1: A present, B present
  //   - Day 2: A present, B absent
  //   - Day 3: A present, B not marked at all
  //   - CANCELLED bkX: mark present on day 1 (must be ignored by report)
  async function mark(bookingId, paketDayId, present) {
    return db.attendanceMark.create({
      data: { bookingId, paketDayId, present, markedByUserId: crew.id },
    });
  }
  await mark(bkA.id, d1.id, true);
  await mark(bkB.id, d1.id, true);
  await mark(bkA.id, d2.id, true);
  await mark(bkB.id, d2.id, false);
  await mark(bkA.id, d3.id, true);
  await mark(bkX.id, d1.id, true); // cancelled booking — should be excluded

  // 3+5+7: per-day counts
  const r = await getPaketAttendanceReport(paket.slug);
  assert(r.totalActive === 2, 'totalActive still 2 (cancelled excluded)');
  const day1 = r.days.find((d) => d.id === d1.id);
  const day2 = r.days.find((d) => d.id === d2.id);
  const day3 = r.days.find((d) => d.id === d3.id);
  assert(day1.markedCount === 2 && day1.presentCount === 2, 'day1: 2 marked + 2 present (cancelled mark ignored)');
  assert(day2.markedCount === 2 && day2.presentCount === 1, 'day2: 2 marked + 1 present');
  assert(day3.markedCount === 1 && day3.presentCount === 1, 'day3: only A marked (1/1)');

  // 4+6: per-jemaah counts + rate
  const rowA = r.bookings.find((b) => b.id === bkA.id);
  const rowB = r.bookings.find((b) => b.id === bkB.id);
  assert(rowA.daysPresent === 3 && rowA.daysMarked === 3, 'A present all 3 days');
  assert(rowA.attendanceRatePct === 100, 'A rate = 100%');
  assert(rowB.daysPresent === 1 && rowB.daysMarked === 2, 'B: present 1, marked 2');
  // B rate: 1 / 3 * 100 = 33.33... → 33
  assert(rowB.attendanceRatePct === 33, `B rate ≈ 33% (got ${rowB.attendanceRatePct})`);

  // Confirm cancelled jemaah NOT in bookings list
  assert(!r.bookings.find((b) => b.id === bkX.id), 'cancelled booking excluded from list');

  // Cleanup
  await db.attendanceMark.deleteMany({ where: { bookingId: { in: [bkA.id, bkB.id, bkX.id] } } });
  await db.booking.deleteMany({ where: { id: { in: [bkA.id, bkB.id, bkX.id] } } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [jemA.id, jemB.id, jemX.id] } } });
  await db.paketDay.deleteMany({ where: { paketId: paket.id } });
  await db.paket.deleteMany({ where: { id: { in: [paket.id, softDel.id] } } });
  await db.user.delete({ where: { id: crew.id } });
  console.log('  cleanup done');

  console.log('\n[5zz smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5zz smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
