// Stage 24 — departure calendar service.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { getDepartureCalendar, clampMonth } from '../src/services/departureCalendar.js';

async function setDeparture(paketId, isoDateUTC) {
  // Force a clean UTC-midnight departure so day-bucket math is predictable.
  const d = new Date(isoDateUTC + 'T00:00:00Z');
  await db.paket.update({ where: { id: paketId }, data: { departureDate: d } });
}

describe('clampMonth', () => {
  test('valid {year, month} pass through', () => {
    assert.deepEqual(clampMonth(2027, 3), { year: 2027, month: 3 });
  });
  test('invalid → defaults to current month', () => {
    const r = clampMonth('not-a-year', 'whatever');
    const now = new Date();
    assert.equal(r.year, now.getUTCFullYear());
    assert.equal(r.month, now.getUTCMonth() + 1);
  });
  test('out-of-range months clamp to current', () => {
    const r = clampMonth(2027, 13);
    const now = new Date();
    assert.equal(r.year, now.getUTCFullYear());
    assert.equal(r.month, now.getUTCMonth() + 1);
  });
});

describe('getDepartureCalendar', () => {
  test('returns 30/31 days for requested month + prev/next nav', async () => {
    const r = await getDepartureCalendar({ year: 2027, month: 6 });   // June = 30
    assert.equal(r.days.length, 30);
    assert.equal(r.year, 2027);
    assert.equal(r.month, 6);
    assert.equal(r.monthLabel, 'Juni 2027');
    assert.deepEqual(r.prev, { year: 2027, month: 5 });
    assert.deepEqual(r.next, { year: 2027, month: 7 });

    const aug = await getDepartureCalendar({ year: 2027, month: 8 });  // August = 31
    assert.equal(aug.days.length, 31);
  });

  test('February leap-year handling', async () => {
    const r = await getDepartureCalendar({ year: 2028, month: 2 });    // 2028 leap
    assert.equal(r.days.length, 29);
    const r2 = await getDepartureCalendar({ year: 2027, month: 2 });
    assert.equal(r2.days.length, 28);
  });

  test('year-boundary nav: Dec → Jan + Jan → Dec', async () => {
    const dec = await getDepartureCalendar({ year: 2027, month: 12 });
    assert.deepEqual(dec.next, { year: 2028, month: 1 });
    const jan = await getDepartureCalendar({ year: 2028, month: 1 });
    assert.deepEqual(jan.prev, { year: 2027, month: 12 });
  });

  test('groups paket into the matching day bucket', async (t) => {
    const tag = makeTag('cal-bucket');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setDeparture(paket.id, '2027-09-15');

    const r = await getDepartureCalendar({ year: 2027, month: 9 });
    const day15 = r.days.find((d) => d.date === '2027-09-15');
    assert.ok(day15);
    assert.ok(day15.departures.some((p) => p.slug === paket.slug));
    // Other days that month don't carry it
    const day14 = r.days.find((d) => d.date === '2027-09-14');
    assert.equal(day14.departureCount, 0);
  });

  test('ARCHIVED + soft-deleted paket excluded', async (t) => {
    const tag = makeTag('cal-archive');
    const paket1 = await tempPaket(t, `pkt-${tag}-1`);
    const paket2 = await tempPaket(t, `pkt-${tag}-2`);
    await setDeparture(paket1.id, '2027-10-10');
    await setDeparture(paket2.id, '2027-10-10');
    await db.paket.update({ where: { id: paket1.id }, data: { status: 'ARCHIVED' } });
    await db.paket.update({ where: { id: paket2.id }, data: { deletedAt: new Date() } });

    const r = await getDepartureCalendar({ year: 2027, month: 10 });
    const day = r.days.find((d) => d.date === '2027-10-10');
    assert.equal(day.departures.find((p) => p.slug === paket1.slug), undefined, 'ARCHIVED hidden');
    assert.equal(day.departures.find((p) => p.slug === paket2.slug), undefined, 'soft-deleted hidden');
  });

  test('isToday flag set on today; totalDepartures sums', async (t) => {
    const tag = makeTag('cal-today');
    const now = new Date(Date.UTC(2027, 4, 7));   // May 7, 2027 UTC
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setDeparture(paket.id, '2027-05-07');

    const r = await getDepartureCalendar({ year: 2027, month: 5, now });
    const todayCell = r.days.find((d) => d.isToday);
    assert.ok(todayCell);
    assert.equal(todayCell.date, '2027-05-07');
    assert.ok(r.totalDepartures >= 1);
  });
});
