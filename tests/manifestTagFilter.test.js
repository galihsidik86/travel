// Stage 229 — manifest tag filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterManifestByTag, filterManifestByDietary, filterManifestByPickup } from '../src/services/adminDashboard.js';

function fakeManifest() {
  return {
    paket: { slug: 'x', title: 'X' },
    bookings: [
      { id: '1', tags: ['VIP'], jemaah: { fullName: 'A', dietary: 'REGULAR' }, pickupId: 'p1' },
      { id: '2', tags: ['LANSIA'], jemaah: { fullName: 'B', dietary: 'DIABETIC' }, pickupId: 'p1' },
      { id: '3', tags: ['VIP', 'HONEYMOON'], jemaah: { fullName: 'C', dietary: 'REGULAR' }, pickupId: 'p2' },
      { id: '4', tags: null, jemaah: { fullName: 'D', dietary: 'REGULAR' }, pickupId: null },
      { id: '5', jemaah: { fullName: 'E', dietary: 'REGULAR' } }, // missing tags field
    ],
    statusCounts: {},
  };
}

test('filterManifestByTag: null result returns null', () => {
  assert.equal(filterManifestByTag(null, 'VIP'), null);
});

test('filterManifestByTag: empty filter returns input unchanged', () => {
  const m = fakeManifest();
  assert.equal(filterManifestByTag(m, ''), m);
});

test('filterManifestByTag: ALL returns input unchanged', () => {
  const m = fakeManifest();
  assert.equal(filterManifestByTag(m, 'ALL'), m);
});

test('filterManifestByTag: narrows to bookings carrying tag', () => {
  const r = filterManifestByTag(fakeManifest(), 'VIP');
  assert.equal(r.bookings.length, 2);
  assert.deepEqual(r.bookings.map((b) => b.id).sort(), ['1', '3']);
  assert.equal(r.filteredByTag, 'VIP');
});

test('filterManifestByTag: case-insensitive (lowercase input → uppercase match)', () => {
  const r = filterManifestByTag(fakeManifest(), 'vip');
  assert.equal(r.bookings.length, 2);
});

test('filterManifestByTag: missing/null tags treated as no-tags (excluded)', () => {
  const r = filterManifestByTag(fakeManifest(), 'VIP');
  // booking id 4 has tags=null, id 5 has no tags field → both excluded
  const ids = r.bookings.map((b) => b.id);
  assert.ok(!ids.includes('4'));
  assert.ok(!ids.includes('5'));
});

test('filterManifestByTag: tag matches across multiple tags on a booking', () => {
  const r = filterManifestByTag(fakeManifest(), 'HONEYMOON');
  // Only id 3 has HONEYMOON
  assert.equal(r.bookings.length, 1);
  assert.equal(r.bookings[0].id, '3');
});

test('filterManifestByTag: unknown tag returns empty bookings (but result wrapped)', () => {
  const r = filterManifestByTag(fakeManifest(), 'NONEXISTENT');
  assert.equal(r.bookings.length, 0);
  assert.equal(r.filteredByTag, 'NONEXISTENT');
});

test('filterManifestByTag: composes with dietary filter (intersection)', () => {
  // Apply tag filter THEN dietary filter → bookings matching BOTH
  const m = fakeManifest();
  const tagged = filterManifestByTag(m, 'VIP');
  const both = filterManifestByDietary(tagged, 'REGULAR');
  // VIP + REGULAR → ids 1 (REG/VIP) + 3 (REG/VIP+HC)
  assert.equal(both.bookings.length, 2);
  assert.deepEqual(both.bookings.map((b) => b.id).sort(), ['1', '3']);
});

test('filterManifestByTag: composes with pickup filter', () => {
  const m = fakeManifest();
  const tagged = filterManifestByTag(m, 'VIP');
  const both = filterManifestByPickup(tagged, 'p1');
  // VIP + pickup p1 → only id 1
  assert.equal(both.bookings.length, 1);
  assert.equal(both.bookings[0].id, '1');
});

test('filterManifestByTag: original bookings array NOT mutated', () => {
  const m = fakeManifest();
  filterManifestByTag(m, 'VIP');
  assert.equal(m.bookings.length, 5);
});

test('filterManifestByTag: whitespace trimmed', () => {
  const r = filterManifestByTag(fakeManifest(), '  VIP  ');
  assert.equal(r.bookings.length, 2);
});
