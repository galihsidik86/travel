// Crew portal integration tests.
// Bundles: 5oo portal+assignment · 5ww attendance grid · 5zz attendance report.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempMuthawwif, fakeReq, systemActor } from './_helpers.js';
import {
  assignCrewToPaket, unassignCrewFromPaket,
  listAssignedPaket, getAssignedManifest,
  listAvailableCrew, listAssignedCrewForPaket,
  listAttendanceDays, getAttendanceGrid, setAttendanceMark,
  getPaketAttendanceReport,
  buildCrewManifestCsv,
} from '../src/services/crewPortal.js';

const ctx = { req: fakeReq, actor: systemActor };

describe('5oo: crew portal + assignment', () => {
  test('non-MUTHAWWIF rejected; assignment idempotent; listing scoped + filters ARCHIVED', async (t) => {
    const tag = makeTag('5oo');
    const crewA = await tempMuthawwif(t, `${tag}-a`);
    const jemaahForBadRole = await tempJemaah(t, `${tag}-jem`);
    const paketActive = await tempPaket(t, `${tag}-act`);
    const paketArchived = await tempPaket(t, `${tag}-arc`);
    await db.paket.update({ where: { id: paketArchived.id }, data: { status: 'ARCHIVED' } });

    // BAD_ROLE on JEMAAH
    await assert.rejects(
      assignCrewToPaket({ ...ctx, paketSlug: paketActive.slug, userId: jemaahForBadRole.id }),
      (err) => err.code === 'BAD_ROLE',
    );

    // Assign twice → idempotent (composite PK upsert)
    await assignCrewToPaket({ ...ctx, paketSlug: paketActive.slug, userId: crewA.id });
    await assignCrewToPaket({ ...ctx, paketSlug: paketActive.slug, userId: crewA.id });
    const count = await db.paketCrew.count({ where: { userId: crewA.id } });
    assert.equal(count, 1, 'double-assign = 1 row');

    // Assign to archived too — list filters it out
    await assignCrewToPaket({ ...ctx, paketSlug: paketArchived.slug, userId: crewA.id });
    const visible = await listAssignedPaket(crewA.id);
    assert.equal(visible.length, 1, 'archived paket filtered from dashboard');
    assert.equal(visible[0].slug, paketActive.slug);

    // Admin helpers
    const available = await listAvailableCrew();
    assert.ok(available.find((u) => u.id === crewA.id), 'listAvailableCrew includes ACTIVE muthawwif');
    const assigned = await listAssignedCrewForPaket(paketActive.slug);
    assert.ok(assigned.find((u) => u.id === crewA.id));

    // Unassign + verify gone
    await unassignCrewFromPaket({ ...ctx, paketSlug: paketActive.slug, userId: crewA.id });
    const after = await listAssignedCrewForPaket(paketActive.slug);
    assert.equal(after.length, 0);
  });

  test('getAssignedManifest returns null for unassigned + strips money fields', async (t) => {
    const tag = makeTag('5oo-manifest');
    const crew = await tempMuthawwif(t, tag);
    const paket = await tempPaket(t, tag);
    const jem = await tempJemaah(t, `${tag}-j`);
    await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

    // Not assigned yet → null
    assert.equal(
      await getAssignedManifest({ userId: crew.id, slug: paket.slug }),
      null,
      'unassigned crew → null (404 path)',
    );

    await assignCrewToPaket({ ...ctx, paketSlug: paket.slug, userId: crew.id });
    const manifest = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
    assert.ok(manifest, 'assigned crew gets manifest');
    assert.equal(manifest.bookings.length, 1);
    // Separation-of-duty: money fields absent
    const b = manifest.bookings[0];
    assert.equal(b.totalAmount, undefined, 'no totalAmount in crew manifest');
    assert.equal(b.paidAmount, undefined, 'no paidAmount in crew manifest');
  });
});

describe('5ww: per-day attendance', () => {
  test('upsert, idempotent re-mark, tuple guard, CANCELLED excluded', async (t) => {
    const tag = makeTag('5ww');
    const crew = await tempMuthawwif(t, tag);
    const otherCrew = await tempMuthawwif(t, `${tag}-other`);
    const paketA = await tempPaket(t, `${tag}-a`, { dayCount: 2 });
    const paketB = await tempPaket(t, `${tag}-b`, { dayCount: 1 });
    const jem = await tempJemaah(t, `${tag}-j`);
    const bkActive = await tempBooking({ paket: paketA, jemaahProfileId: jem.jemaah.id });
    const bkCancelled = await tempBooking({ paket: paketA, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({ where: { id: bkCancelled.id }, data: { status: 'CANCELLED' } });
    const bkOtherPaket = await tempBooking({ paket: paketB, jemaahProfileId: jem.jemaah.id });

    await assignCrewToPaket({ ...ctx, paketSlug: paketA.slug, userId: crew.id });
    const [day1, day2] = paketA.days;

    // Unassigned crew refused
    await assert.rejects(
      setAttendanceMark({
        ...ctx, userId: otherCrew.id,
        slug: paketA.slug, dayId: day1.id, bookingId: bkActive.id, present: true,
      }),
      (err) => err.code === 'NOT_ASSIGNED',
    );

    // Tuple guard — booking from other paket
    await assert.rejects(
      setAttendanceMark({
        ...ctx, userId: crew.id,
        slug: paketA.slug, dayId: day1.id, bookingId: bkOtherPaket.id, present: true,
      }),
      (err) => err.code === 'NOT_FOUND',
    );

    // Mark present, then flip absent with notes — idempotent (1 row)
    await setAttendanceMark({
      ...ctx, userId: crew.id,
      slug: paketA.slug, dayId: day1.id, bookingId: bkActive.id, present: true,
    });
    await setAttendanceMark({
      ...ctx, userId: crew.id,
      slug: paketA.slug, dayId: day1.id, bookingId: bkActive.id,
      present: false, notes: 'Sakit',
    });
    const rows = await db.attendanceMark.count({
      where: { bookingId: bkActive.id, paketDayId: day1.id },
    });
    assert.equal(rows, 1, 'composite unique respects re-mark');

    // Overview reflects: day1 has 1 marked (absent, present=0); day2 unmarked
    const overview = await listAttendanceDays({ userId: crew.id, slug: paketA.slug });
    assert.equal(overview.totalActive, 1, 'CANCELLED excluded from totalActive');
    const d1 = overview.days.find((d) => d.id === day1.id);
    assert.equal(d1.markedCount, 1);
    assert.equal(d1.presentCount, 0);

    // Grid: CANCELLED booking excluded + notes preserved
    const grid = await getAttendanceGrid({ userId: crew.id, slug: paketA.slug, dayId: day1.id });
    assert.equal(grid.bookings.length, 1, 'grid hides CANCELLED');
    assert.equal(grid.bookings[0].mark.present, false);
    assert.equal(grid.bookings[0].mark.notes, 'Sakit');

    // Day from other paket → null
    const wrong = await getAttendanceGrid({
      userId: crew.id, slug: paketA.slug, dayId: paketB.days[0].id,
    });
    assert.equal(wrong, null, 'day from other paket → null');
  });
});

describe('5ss: crew manifest CSV', () => {
  // Minimal RFC 4180 parser, good enough for assertions below.
  function parseCsvLine(line) {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { inQ = false; continue; }
        cur += ch;
      } else {
        if (ch === ',') { out.push(cur); cur = ''; continue; }
        if (ch === '"') { inQ = true; continue; }
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  test('null for unassigned; BOM + escape + money-stripped cols for assigned', async (t) => {
    const tag = makeTag('5ss');
    const crew = await tempMuthawwif(t, tag);
    const stranger = await tempMuthawwif(t, `${tag}-stranger`);
    const paket = await tempPaket(t, tag);

    // Jemaah with edge-case names — comma, quote
    const jemComma = await db.jemaahProfile.create({
      data: { fullName: 'Ahmad, Bin Yusuf', phone: '+62811' },
    });
    const jemQuote = await db.jemaahProfile.create({
      data: { fullName: 'Siti "Aisyah"', phone: '+62822' },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: { in: [jemComma.id, jemQuote.id] } } }));

    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: jemComma.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'DP_PAID',
      },
    });
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: jemQuote.id,
        kelas: 'TRIPLE', paxCount: 2, totalAmount: '2000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: jemComma.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
      },
    });

    // Unassigned crew → null
    assert.equal(
      await buildCrewManifestCsv({ userId: stranger.id, slug: paket.slug }),
      null,
      'unassigned → null (404 path)',
    );

    await assignCrewToPaket({ ...ctx, paketSlug: paket.slug, userId: crew.id });

    const out = await buildCrewManifestCsv({ userId: crew.id, slug: paket.slug });
    assert.ok(out.csv);
    assert.equal(out.csv.charCodeAt(0), 0xFEFF, 'starts with UTF-8 BOM');

    const lines = out.csv.split('\r\n');
    const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ''));
    assert.ok(header.includes('Booking No'));
    assert.ok(header.some((c) => c.startsWith('Doc ')));
    assert.ok(!header.includes('Total (IDR)') && !header.includes('Dibayar (IDR)'),
      'no money columns (separation of duty)');
    assert.equal(lines.length, 3, 'header + 2 active bookings (CANCELLED excluded)');

    // Edge-case names round-trip through escape
    const row1 = parseCsvLine(lines[1]);
    const row2 = parseCsvLine(lines[2]);
    const ahmad = [row1, row2].find((r) => r[4] === 'Ahmad, Bin Yusuf');
    const siti = [row1, row2].find((r) => r[4] === 'Siti "Aisyah"');
    assert.ok(ahmad, 'comma preserved');
    assert.ok(siti, 'quote preserved (escaped as "")');

    // Filename pattern crew_manifest_<slug>_<YYYY-MM-DD>.csv
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(out.filename, `crew_manifest_${paket.slug}_${today}.csv`);
  });
});

describe('5zz: admin attendance report', () => {
  test('null for missing/soft-deleted; counts roll up; CANCELLED excluded; rate divides by totalDays', async (t) => {
    const tag = makeTag('5zz');
    assert.equal(await getPaketAttendanceReport(`nope-${tag}`), null, 'missing → null');

    const crew = await tempMuthawwif(t, tag);
    const paket = await tempPaket(t, tag, { dayCount: 3 });
    const [d1, d2, d3] = paket.days;
    const jemA = await tempJemaah(t, `${tag}-a`);
    const jemB = await tempJemaah(t, `${tag}-b`);
    const jemX = await tempJemaah(t, `${tag}-x`);
    const bkA = await tempBooking({ paket, jemaahProfileId: jemA.jemaah.id });
    const bkB = await tempBooking({ paket, jemaahProfileId: jemB.jemaah.id });
    const bkX = await tempBooking({ paket, jemaahProfileId: jemX.jemaah.id });
    await db.booking.update({ where: { id: bkX.id }, data: { status: 'CANCELLED' } });

    // A present all 3, B present 1 of 2 marked (1 unmarked), X cancelled
    async function mark(bookingId, paketDayId, present) {
      return db.attendanceMark.create({
        data: { bookingId, paketDayId, present, markedByUserId: crew.id },
      });
    }
    await mark(bkA.id, d1.id, true);
    await mark(bkA.id, d2.id, true);
    await mark(bkA.id, d3.id, true);
    await mark(bkB.id, d1.id, true);
    await mark(bkB.id, d2.id, false);
    // bkB d3 unmarked
    await mark(bkX.id, d1.id, true); // cancelled — must be ignored

    const r = await getPaketAttendanceReport(paket.slug);
    assert.equal(r.totalActive, 2, 'CANCELLED excluded from active count');
    assert.equal(r.totalDays, 3);

    const day1 = r.days.find((d) => d.id === d1.id);
    assert.equal(day1.markedCount, 2, 'day1: 2 marked (cancelled ignored)');
    assert.equal(day1.presentCount, 2);

    const rowA = r.bookings.find((b) => b.id === bkA.id);
    const rowB = r.bookings.find((b) => b.id === bkB.id);
    assert.equal(rowA.attendanceRatePct, 100, 'A 100%');
    // B: 1 present / 3 total days = 33% (unmarked day3 counts as not-present)
    assert.equal(rowB.attendanceRatePct, 33, 'B rate divides by totalDays (unmarked = not-present)');
    assert.equal(rowB.daysPresent, 1);
    assert.equal(rowB.daysMarked, 2);
    assert.ok(!r.bookings.find((b) => b.id === bkX.id), 'cancelled booking excluded from list');
  });
});
