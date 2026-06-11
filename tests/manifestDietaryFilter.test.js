// Stage 215 — manifest dietary filter helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterManifestByDietary } from '../src/services/adminDashboard.js';

function fakeManifest() {
  return {
    paket: { slug: 'x', title: 'X' },
    bookings: [
      { id: '1', jemaah: { fullName: 'Reg1', dietary: 'REGULAR' } },
      { id: '2', jemaah: { fullName: 'Veg1', dietary: 'VEGETARIAN' } },
      { id: '3', jemaah: { fullName: 'Diab1', dietary: 'DIABETIC' } },
      { id: '4', jemaah: { fullName: 'Other1', dietary: 'OTHER' } },
      { id: '5', jemaah: { fullName: 'Null1' } }, // missing dietary → treat as REGULAR
    ],
    statusCounts: {},
  };
}

test('filterManifestByDietary: null result returns null', () => {
  assert.equal(filterManifestByDietary(null, 'VEGETARIAN'), null);
});

test('filterManifestByDietary: empty filter returns input unchanged', () => {
  const m = fakeManifest();
  const r = filterManifestByDietary(m, '');
  assert.equal(r, m);
  assert.equal(r.bookings.length, 5);
});

test('filterManifestByDietary: ALL returns input unchanged', () => {
  const m = fakeManifest();
  const r = filterManifestByDietary(m, 'ALL');
  assert.equal(r, m);
});

test('filterManifestByDietary: exact code narrows', () => {
  const r = filterManifestByDietary(fakeManifest(), 'VEGETARIAN');
  assert.equal(r.bookings.length, 1);
  assert.equal(r.bookings[0].jemaah.fullName, 'Veg1');
  assert.equal(r.filteredByDietary, 'VEGETARIAN');
});

test('filterManifestByDietary: null/missing dietary counts as REGULAR', () => {
  const r = filterManifestByDietary(fakeManifest(), 'REGULAR');
  assert.equal(r.bookings.length, 2); // Reg1 + Null1
  const names = r.bookings.map((b) => b.jemaah.fullName).sort();
  assert.deepEqual(names, ['Null1', 'Reg1']);
});

test('filterManifestByDietary: __SPECIAL__ shows all non-REGULAR', () => {
  const r = filterManifestByDietary(fakeManifest(), '__SPECIAL__');
  assert.equal(r.bookings.length, 3); // Veg1 + Diab1 + Other1
  assert.equal(r.filteredByDietary, '__SPECIAL__');
});

test('filterManifestByDietary: unknown code silently returns input (defensive against renamed enum)', () => {
  const m = fakeManifest();
  const r = filterManifestByDietary(m, 'PIZZA');
  assert.equal(r, m);
  assert.equal(r.bookings.length, 5);
});

test('filterManifestByDietary: original bookings array NOT mutated', () => {
  const m = fakeManifest();
  filterManifestByDietary(m, 'VEGETARIAN');
  assert.equal(m.bookings.length, 5);
});
