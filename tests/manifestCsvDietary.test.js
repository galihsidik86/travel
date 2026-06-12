// Stage 217 — manifest CSV export includes dietary + dietaryNotes columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { exportManifestCsv } from '../src/services/adminDashboard.js';

test('exportManifestCsv: header includes Dietary + Dietary Notes', async (t) => {
  const tag = makeTag('s217-header');
  const paket = await tempPaket(t, tag);
  const r = await exportManifestCsv(paket.slug);
  // First row after BOM is headers
  const firstRow = r.csv.replace(/^\uFEFF/, '').split('\r\n')[0];
  assert.match(firstRow, /Dietary/);
  assert.match(firstRow, /Dietary Notes/);
});

test('exportManifestCsv: defaults to REGULAR for old jemaah without diet set', async (t) => {
  const tag = makeTag('s217-default');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await exportManifestCsv(paket.slug);
  const lines = r.csv.replace(/^\uFEFF/, '').split('\r\n');
  // header + 1 data row
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,REGULAR,/);
});

test('exportManifestCsv: emits set diet + notes', async (t) => {
  const tag = makeTag('s217-set');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { dietary: 'DIABETIC', dietaryNotes: 'no rice' },
  });
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await exportManifestCsv(paket.slug);
  assert.match(r.csv, /DIABETIC/);
  assert.match(r.csv, /no rice/);
});

test('exportManifestCsv: dietary notes containing commas are quoted (RFC 4180)', async (t) => {
  const tag = makeTag('s217-quote');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { dietary: 'OTHER', dietaryNotes: 'no peanuts, dairy' },
  });
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await exportManifestCsv(paket.slug);
  // The notes field should be quoted because it contains a comma
  assert.match(r.csv, /"no peanuts, dairy"/);
});

test('exportManifestCsv: empty notes render as empty cell (not null)', async (t) => {
  const tag = makeTag('s217-empty-notes');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { dietary: 'VEGETARIAN', dietaryNotes: null },
  });
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await exportManifestCsv(paket.slug);
  // Row ends with: ,VEGETARIAN,\r\n  (empty notes after last comma)
  // No literal "null" string in the CSV
  assert.doesNotMatch(r.csv, /,null,/);
  assert.doesNotMatch(r.csv, /,null\r/);
});
