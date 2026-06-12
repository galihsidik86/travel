// Stage 258 — manifest group filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterManifestByGroup,
  filterManifestByTag,
  filterManifestByDietary,
  filterManifestByPickup,
} from '../src/services/adminDashboard.js';

function fakeManifest() {
  return {
    paket: { slug: 'x', title: 'X' },
    bookings: [
      { id: '1', groupKey: 'G-AB12CD', tags: ['VIP'], jemaah: { fullName: 'A', dietary: 'REGULAR' }, pickupId: 'p1' },
      { id: '2', groupKey: 'G-AB12CD', tags: [], jemaah: { fullName: 'B', dietary: 'DIABETIC' }, pickupId: 'p1' },
      { id: '3', groupKey: 'G-XY99ZZ', tags: ['VIP'], jemaah: { fullName: 'C', dietary: 'REGULAR' }, pickupId: 'p2' },
      { id: '4', groupKey: null, tags: null, jemaah: { fullName: 'D', dietary: 'REGULAR' }, pickupId: null },
      { id: '5', jemaah: { fullName: 'E', dietary: 'REGULAR' } },
    ],
    statusCounts: {},
  };
}

test('filterManifestByGroup: null result returns null', () => {
  assert.equal(filterManifestByGroup(null, 'G-AB12CD'), null);
});

test('filterManifestByGroup: empty filter returns input unchanged', () => {
  const m = fakeManifest();
  assert.equal(filterManifestByGroup(m, ''), m);
});

test('filterManifestByGroup: ALL returns input unchanged', () => {
  const m = fakeManifest();
  assert.equal(filterManifestByGroup(m, 'ALL'), m);
});

test('filterManifestByGroup: undefined returns input unchanged', () => {
  const m = fakeManifest();
  assert.equal(filterManifestByGroup(m, undefined), m);
});

test('filterManifestByGroup: narrows to bookings sharing key', () => {
  const r = filterManifestByGroup(fakeManifest(), 'G-AB12CD');
  assert.equal(r.bookings.length, 2);
  assert.deepEqual(r.bookings.map((b) => b.id).sort(), ['1', '2']);
  assert.equal(r.filteredByGroup, 'G-AB12CD');
});

test('filterManifestByGroup: ungrouped bookings excluded', () => {
  const r = filterManifestByGroup(fakeManifest(), 'G-AB12CD');
  const ids = r.bookings.map((b) => b.id);
  assert.ok(!ids.includes('4'));
  assert.ok(!ids.includes('5'));
});

test('filterManifestByGroup: unknown key returns empty bookings', () => {
  const r = filterManifestByGroup(fakeManifest(), 'G-NOPE99');
  assert.equal(r.bookings.length, 0);
  assert.equal(r.filteredByGroup, 'G-NOPE99');
});

test('filterManifestByGroup: case-sensitive exact match (group keys are uppercase)', () => {
  // Group keys are auto-generated uppercase — lowercase input shouldn't match
  const r = filterManifestByGroup(fakeManifest(), 'g-ab12cd');
  assert.equal(r.bookings.length, 0);
});

test('filterManifestByGroup: whitespace trimmed', () => {
  const r = filterManifestByGroup(fakeManifest(), '  G-AB12CD  ');
  assert.equal(r.bookings.length, 2);
});

test('filterManifestByGroup: composes with tag filter (intersection)', () => {
  const m = fakeManifest();
  const grouped = filterManifestByGroup(m, 'G-AB12CD');
  const both = filterManifestByTag(grouped, 'VIP');
  // Group AB12CD + VIP → only id 1
  assert.equal(both.bookings.length, 1);
  assert.equal(both.bookings[0].id, '1');
});

test('filterManifestByGroup: composes with dietary filter', () => {
  const m = fakeManifest();
  const grouped = filterManifestByGroup(m, 'G-AB12CD');
  const both = filterManifestByDietary(grouped, 'DIABETIC');
  // Group AB12CD + DIABETIC → only id 2
  assert.equal(both.bookings.length, 1);
  assert.equal(both.bookings[0].id, '2');
});

test('filterManifestByGroup: composes with pickup filter', () => {
  const m = fakeManifest();
  const grouped = filterManifestByGroup(m, 'G-AB12CD');
  const both = filterManifestByPickup(grouped, 'p1');
  // Group AB12CD + pickup p1 → both id 1 and 2 share p1
  assert.equal(both.bookings.length, 2);
});

test('filterManifestByGroup: original bookings array NOT mutated', () => {
  const m = fakeManifest();
  filterManifestByGroup(m, 'G-AB12CD');
  assert.equal(m.bookings.length, 5);
});
