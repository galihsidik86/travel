// Stage 223 — per-paket required document list drives the checklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  getPreDepartureChecklist,
  resolveRequiredDocs,
  DEFAULT_REQUIRED_DOCS,
} from '../src/services/preDepartureChecklist.js';
import { PaketSchema } from '../src/services/paketAdmin.js';

const requiredFields = (overrides = {}) => ({
  slug: 'p-' + Math.random().toString(36).slice(2, 8),
  title: 'Test',
  departureDate: '2027-01-01',
  returnDate: '2027-01-10',
  durationDays: 10,
  kursiTotal: 10,
  ...overrides,
});

test('resolveRequiredDocs: null → DEFAULT_REQUIRED_DOCS', () => {
  assert.deepEqual(resolveRequiredDocs(null), DEFAULT_REQUIRED_DOCS);
});

test('resolveRequiredDocs: empty array → DEFAULT', () => {
  assert.deepEqual(resolveRequiredDocs([]), DEFAULT_REQUIRED_DOCS);
});

test('resolveRequiredDocs: filters unknown enum strings', () => {
  const r = resolveRequiredDocs(['VISA_UMROH', 'NONSENSE', 'HEALTH_CERT']);
  assert.deepEqual(r, ['VISA_UMROH', 'HEALTH_CERT']);
});

test('resolveRequiredDocs: filters PASSPORT (handled separately)', () => {
  const r = resolveRequiredDocs(['PASSPORT', 'VISA_UMROH']);
  assert.deepEqual(r, ['VISA_UMROH']);
});

test('resolveRequiredDocs: dedupes + preserves order', () => {
  const r = resolveRequiredDocs(['VISA_UMROH', 'HEALTH_CERT', 'VISA_UMROH']);
  assert.deepEqual(r, ['VISA_UMROH', 'HEALTH_CERT']);
});

test('resolveRequiredDocs: lowercases input upcases', () => {
  const r = resolveRequiredDocs(['visa_umroh']);
  assert.deepEqual(r, ['VISA_UMROH']);
});

test('PaketSchema.requiredDocs: comma-separated string parsed to array', () => {
  const r = PaketSchema.parse(requiredFields({ requiredDocs: 'VISA_UMROH, HEALTH_CERT' }));
  assert.deepEqual(r.requiredDocs, ['VISA_UMROH', 'HEALTH_CERT']);
});

test('PaketSchema.requiredDocs: empty array → null (explicit clear)', () => {
  const r = PaketSchema.parse(requiredFields({ requiredDocs: [] }));
  assert.equal(r.requiredDocs, null);
});

test('PaketSchema.requiredDocs: omitted → undefined (no change signal)', () => {
  const r = PaketSchema.parse(requiredFields());
  assert.equal(r.requiredDocs, undefined);
});

test('getPreDepartureChecklist: null requiredDocs → uses 4 default doc checks', async (t) => {
  const tag = makeTag('s223-default');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await getPreDepartureChecklist(paket.slug);
  assert.deepEqual(r.requiredDocs, DEFAULT_REQUIRED_DOCS);
  // 4 always-present (passportPresent/Valid/roomAssigned/emergencyContact) + 4 doc checks = 8
  assert.equal(r.rows[0].total, 8);
});

test('getPreDepartureChecklist: trimmed requiredDocs gives FEWER checks (Turkey-style paket)', async (t) => {
  const tag = makeTag('s223-trim');
  const paket = await tempPaket(t, tag);
  // Trim to just passport-only (no visa, no vaccine — Turkey paket)
  await db.paket.update({ where: { id: paket.id }, data: { requiredDocs: ['HEALTH_CERT'] } });
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await getPreDepartureChecklist(paket.slug);
  assert.deepEqual(r.requiredDocs, ['HEALTH_CERT']);
  // 4 always-present + 1 doc check = 5
  assert.equal(r.rows[0].total, 5);
});

test('getPreDepartureChecklist: trimming docs lifts the score (dropping a missing doc = no penalty)', async (t) => {
  const tag = makeTag('s223-lift');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // First read with default (4 missing docs) → score baseline
  const baseline = await getPreDepartureChecklist(paket.slug);
  const baselineScore = baseline.rows[0].score;

  // Now narrow requiredDocs to just one (HEALTH_CERT) — the 3 dropped ones no longer count
  await db.paket.update({ where: { id: paket.id }, data: { requiredDocs: ['HEALTH_CERT'] } });
  const trimmed = await getPreDepartureChecklist(paket.slug);
  // Trimmed should score higher than baseline (we removed missing checks)
  assert.ok(trimmed.rows[0].score >= baselineScore, `trimmed ${trimmed.rows[0].score} should be ≥ baseline ${baselineScore}`);
});

test('getPreDepartureChecklist: always-present checks (passport/room/emergency) survive trim to []', async (t) => {
  const tag = makeTag('s223-trim-all');
  const paket = await tempPaket(t, tag);
  // Trim to empty array — falls back to DEFAULT per resolveRequiredDocs;
  // so we set [HEALTH_CERT] which is a valid non-empty value, then verify count.
  await db.paket.update({ where: { id: paket.id }, data: { requiredDocs: ['HEALTH_CERT'] } });
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await getPreDepartureChecklist(paket.slug);
  // 4 always-present + 1 from list
  assert.equal(r.rows[0].total, 5);
  // Always-present check keys exist
  assert.ok('passportPresent' in r.rows[0].checks);
  assert.ok('passportValid' in r.rows[0].checks);
  assert.ok('roomAssigned' in r.rows[0].checks);
  assert.ok('emergencyContact' in r.rows[0].checks);
});
