// Stage 140 — per-paket attendance trend (sparkline data). Both crew
// listAttendanceDays + admin getPaketAttendanceReport return a `trend`
// object the view renders as an inline SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempPaket, tempJemaah, tempBooking, tempMuthawwif } from './_helpers.js';
import {
  listAttendanceDays, getPaketAttendanceReport, buildAttendanceTrend,
} from '../src/services/crewPortal.js';

async function seedAttendance(paket, crewUserId, bookingId, dayId, present) {
  return db.attendanceMark.create({
    data: {
      bookingId, paketDayId: dayId,
      present, markedByUserId: crewUserId,
    },
  });
}

test('buildAttendanceTrend: empty days → ticks=[], avgPct=null', () => {
  const r = buildAttendanceTrend([], 0);
  assert.deepEqual(r.ticks, []);
  assert.equal(r.avgPct, null);
});

test('buildAttendanceTrend: totalActive=0 → empty (no denominator)', () => {
  const r = buildAttendanceTrend([{ dayNumber: 1, presentCount: 0, markedCount: 0 }], 0);
  assert.deepEqual(r.ticks, []);
  assert.equal(r.avgPct, null);
});

test('buildAttendanceTrend: computes presentPct per day + avgPct over marked days', () => {
  const days = [
    { dayNumber: 1, dateLabel: '1 Mar', title: 'Madinah arrival', presentCount: 10, markedCount: 10 },
    { dayNumber: 2, dateLabel: '2 Mar', title: 'Mekkah',          presentCount: 8,  markedCount: 10 },
    { dayNumber: 3, dateLabel: '3 Mar', title: 'Umrah',           presentCount: 0,  markedCount: 0 },  // unmarked
  ];
  const r = buildAttendanceTrend(days, 10);
  assert.equal(r.ticks.length, 3);
  assert.equal(r.ticks[0].presentPct, 100);
  assert.equal(r.ticks[1].presentPct, 80);
  assert.equal(r.ticks[2].presentPct, 0);
  assert.equal(r.ticks[2].hasData, false, 'unmarked day flagged so view can dim it');
  // avgPct excludes unmarked days — averages 100 + 80 = 90
  assert.equal(r.avgPct, 90);
  assert.equal(r.markedDayCount, 2);
});

test('buildAttendanceTrend: all-unmarked days → avgPct null', () => {
  const days = [
    { dayNumber: 1, presentCount: 0, markedCount: 0 },
    { dayNumber: 2, presentCount: 0, markedCount: 0 },
  ];
  const r = buildAttendanceTrend(days, 10);
  assert.equal(r.avgPct, null, 'no marks at all → no avg');
  assert.equal(r.markedDayCount, 0);
  assert.equal(r.ticks.length, 2);
});

test('listAttendanceDays: returned shape includes trend + ticks match days', async (t) => {
  const tag = makeTag('s140-crew');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  const crew = await tempMuthawwif(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Mark day 1: present, day 2: absent (1 active jemaah only)
  await seedAttendance(paket, crew.id, booking.id, paket.days[0].id, true);
  await seedAttendance(paket, crew.id, booking.id, paket.days[1].id, false);

  const r = await listAttendanceDays({ userId: crew.id, slug: paket.slug });
  assert.ok(r);
  assert.ok(r.trend);
  assert.equal(r.trend.ticks.length, 3);
  // Day 1: 1/1 → 100%
  assert.equal(r.trend.ticks[0].presentPct, 100);
  // Day 2: 0/1 → 0%
  assert.equal(r.trend.ticks[1].presentPct, 0);
  // Day 3: unmarked
  assert.equal(r.trend.ticks[2].hasData, false);
  // avgPct = (100 + 0) / 2 = 50
  assert.equal(r.trend.avgPct, 50);
});

test('getPaketAttendanceReport: returned shape includes trend (admin view)', async (t) => {
  const tag = makeTag('s140-admin');
  const paket = await tempPaket(t, tag, { dayCount: 2 });
  const crew = await tempMuthawwif(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  const jem1 = await tempJemaah(t, `${tag}-j1`);
  const jem2 = await tempJemaah(t, `${tag}-j2`);
  const b1 = await tempBooking({ paket, jemaahProfileId: jem1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem2.jemaah.id });

  // Day 1: both present, day 2: only 1 present
  await seedAttendance(paket, crew.id, b1.id, paket.days[0].id, true);
  await seedAttendance(paket, crew.id, b2.id, paket.days[0].id, true);
  await seedAttendance(paket, crew.id, b1.id, paket.days[1].id, true);
  await seedAttendance(paket, crew.id, b2.id, paket.days[1].id, false);

  const r = await getPaketAttendanceReport(paket.slug);
  assert.ok(r.trend);
  assert.equal(r.trend.ticks.length, 2);
  // Day 1: 2/2 = 100%
  assert.equal(r.trend.ticks[0].presentPct, 100);
  // Day 2: 1/2 = 50%
  assert.equal(r.trend.ticks[1].presentPct, 50);
  assert.equal(r.trend.avgPct, 75);
});
