// Stage 261 — per-group CSV builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupCsv } from '../src/services/bookingGroupCsv.js';

function fakeGroup(overrides = {}) {
  return {
    groupKey: 'G-AB12CD',
    label: 'Keluarga Pak Ahmad',
    members: [
      {
        id: '1', bookingNo: 'RP-2026-00001', status: 'LUNAS',
        kelas: 'QUAD', paxCount: 2,
        totalAmount: '20000000', paidAmount: '20000000', currency: 'IDR',
        createdAt: new Date('2026-03-01T00:00:00Z'),
        paket: { slug: 'umroh-r1', title: 'Umroh R1', departureDate: new Date('2026-06-01T00:00:00Z') },
        jemaah: { id: 'j1', fullName: 'Ahmad', phone: '+62811', email: 'a@x' },
        agent: { id: 'a1', slug: 'ahmad-w', displayName: 'Ahmad W' },
      },
      {
        id: '2', bookingNo: 'RP-2026-00002', status: 'DP_PAID',
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '10000000', paidAmount: '3000000', currency: 'IDR',
        createdAt: new Date('2026-03-02T00:00:00Z'),
        paket: { slug: 'umroh-r1', title: 'Umroh R1', departureDate: new Date('2026-06-01T00:00:00Z') },
        jemaah: { id: 'j2', fullName: 'Aisyah', phone: '+62812', email: 'b@x' },
        agent: null, // walk-in
      },
    ],
    ...overrides,
  };
}

test('buildGroupCsv: starts with UTF-8 BOM', () => {
  const csv = buildGroupCsv(fakeGroup());
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test('buildGroupCsv: uses CRLF line separator', () => {
  const csv = buildGroupCsv(fakeGroup());
  assert.ok(csv.includes('\r\n'));
});

test('buildGroupCsv: emits header + member rows + TOTAL footer', () => {
  const csv = buildGroupCsv(fakeGroup());
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  // header + 2 members + TOTAL = 4 lines
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('Group Key,Group Label,'));
  assert.ok(lines[1].includes('RP-2026-00001'));
  assert.ok(lines[2].includes('RP-2026-00002'));
  assert.ok(lines[3].includes('TOTAL'));
});

test('buildGroupCsv: TOTAL footer sums money correctly', () => {
  const csv = buildGroupCsv(fakeGroup());
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  // Footer cells: groupKey, label, "TOTAL", "", "", paxTotal, "N jemaah", "", ...
  //   Total amount: 20m + 10m = 30m
  //   Total paid: 20m + 3m = 23m
  //   Balance: 30m - 23m = 7m
  assert.ok(lines[3].includes('30000000'));
  assert.ok(lines[3].includes('23000000'));
  assert.ok(lines[3].includes('7000000'));
});

test('buildGroupCsv: walk-in member shows blank agen columns', () => {
  const csv = buildGroupCsv(fakeGroup());
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  // Member 2 has agent=null; should have empty agen columns, not "Kantor Pusat"
  const member2 = lines[2];
  // Find the agen slug column (13th cell, 0-indexed = 12)
  const cells = member2.split(',');
  // After paket departure (index 11), agent slug + name (12 + 13)
  assert.equal(cells[12], ''); // agen slug empty for walk-in
  assert.equal(cells[13], ''); // agen name empty for walk-in
});

test('buildGroupCsv: escapes label with commas via RFC 4180 quoting', () => {
  const csv = buildGroupCsv(fakeGroup({ label: 'Keluarga, Pak Ahmad' }));
  // Comma in label triggers wrap+quote
  assert.ok(csv.includes('"Keluarga, Pak Ahmad"'));
});

test('buildGroupCsv: escapes embedded quote by doubling', () => {
  const csv = buildGroupCsv(fakeGroup({ label: 'Pak "Si Bos" Ahmad' }));
  assert.ok(csv.includes('"Pak ""Si Bos"" Ahmad"'));
});

test('buildGroupCsv: null/missing fields render as empty', () => {
  const csv = buildGroupCsv(fakeGroup({ label: null }));
  // Empty label not "null" string
  assert.ok(!csv.includes('null,'));
});

test('buildGroupCsv: empty group → header + empty TOTAL footer only', () => {
  const csv = buildGroupCsv({ groupKey: 'G-EMPTY', label: null, members: [] });
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  // header + TOTAL footer = 2 lines
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('TOTAL'));
  assert.ok(lines[1].includes('0 jemaah'));
});

test('buildGroupCsv: handles null group → empty string', () => {
  assert.equal(buildGroupCsv(null), '');
});

test('buildGroupCsv: ISO date format for departure + createdAt', () => {
  const csv = buildGroupCsv(fakeGroup());
  assert.ok(csv.includes('2026-06-01'));
  assert.ok(csv.includes('2026-03-01'));
});
