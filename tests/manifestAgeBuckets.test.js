// Stage 191 — manifest age-bracket counts. Pure compute helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAge, computeAgeBuckets,
  ANAK_MAX_YEARS, LANSIA_MIN_YEARS,
} from '../src/services/manifestAgeBuckets.js';

test('exported brackets sane', () => {
  assert.equal(ANAK_MAX_YEARS, 12);
  assert.equal(LANSIA_MIN_YEARS, 60);
});

test('computeAge: null birthDate → null', () => {
  assert.equal(computeAge(null, new Date('2026-06-01')), null);
  assert.equal(computeAge(undefined, new Date('2026-06-01')), null);
});

test('computeAge: birthday already passed in year', () => {
  // Born 1980-01-15, ref 2026-06-01 → 46 (Jan birthday passed by June)
  assert.equal(
    computeAge(new Date('1980-01-15'), new Date('2026-06-01')),
    46,
  );
});

test('computeAge: birthday not yet reached in year', () => {
  // Born 1980-12-15, ref 2026-06-01 → 45 (Dec birthday hasn't come yet)
  assert.equal(
    computeAge(new Date('1980-12-15'), new Date('2026-06-01')),
    45,
  );
});

test('computeAge: same-day birthday → counts as that year', () => {
  // Born 1980-06-01, ref 2026-06-01 → 46
  assert.equal(
    computeAge(new Date('1980-06-01'), new Date('2026-06-01')),
    46,
  );
});

test('computeAgeBuckets: empty bookings → zeros', () => {
  const r = computeAgeBuckets({ bookings: [], departureDate: new Date('2026-06-01') });
  assert.deepEqual(r, { anak: 0, dewasa: 0, lansia: 0, unknown: 0, total: 0 });
});

test('computeAgeBuckets: classifies into 3 brackets', () => {
  const dep = new Date('2026-06-01');
  const bookings = [
    { status: 'PENDING', paxCount: 1, jemaah: { birthDate: new Date('2018-06-01') } }, // 8y → anak
    { status: 'LUNAS',   paxCount: 1, jemaah: { birthDate: new Date('1990-06-01') } }, // 36y → dewasa
    { status: 'LUNAS',   paxCount: 1, jemaah: { birthDate: new Date('1960-06-01') } }, // 66y → lansia
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.anak, 1);
  assert.equal(r.dewasa, 1);
  assert.equal(r.lansia, 1);
  assert.equal(r.total, 3);
});

test('computeAgeBuckets: paxCount-aware (family booking)', () => {
  const dep = new Date('2026-06-01');
  const bookings = [
    // 3-pax family, lead jemaah birthDate is adult → all 3 dewasa
    { status: 'PENDING', paxCount: 3, jemaah: { birthDate: new Date('1985-01-01') } },
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.dewasa, 3);
  assert.equal(r.total, 3);
});

test('computeAgeBuckets: excludes CANCELLED + REFUNDED', () => {
  const dep = new Date('2026-06-01');
  const bookings = [
    { status: 'LUNAS',     paxCount: 1, jemaah: { birthDate: new Date('1990-06-01') } },
    { status: 'CANCELLED', paxCount: 5, jemaah: { birthDate: new Date('1990-06-01') } },
    { status: 'REFUNDED',  paxCount: 2, jemaah: { birthDate: new Date('1990-06-01') } },
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.dewasa, 1, 'only LUNAS counted');
  assert.equal(r.total, 1);
});

test('computeAgeBuckets: null birthDate → unknown bucket', () => {
  const dep = new Date('2026-06-01');
  const bookings = [
    { status: 'PENDING', paxCount: 1, jemaah: { birthDate: null } },
    { status: 'PENDING', paxCount: 2, jemaah: {} },
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.unknown, 3);
});

test('computeAgeBuckets: exact 12-year boundary → dewasa (>= 12)', () => {
  const dep = new Date('2026-06-01');
  // Born 2014-06-01 → exactly 12 on dep
  const bookings = [
    { status: 'PENDING', paxCount: 1, jemaah: { birthDate: new Date('2014-06-01') } },
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.dewasa, 1, '12-year-old is dewasa (not anak)');
});

test('computeAgeBuckets: exact 60-year boundary → lansia', () => {
  const dep = new Date('2026-06-01');
  const bookings = [
    { status: 'PENDING', paxCount: 1, jemaah: { birthDate: new Date('1966-06-01') } },
  ];
  const r = computeAgeBuckets({ bookings, departureDate: dep });
  assert.equal(r.lansia, 1, '60-year-old is lansia');
});
