// Stage 210 — jemaah dietary preference. Catering / hotel meal planning
// uses this on the manifest pill.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import { updateJemaah, JemaahSchema, META } from '../src/services/jemaahAdmin.js';

const baseInput = (tag) => ({
  fullName: `Test ${tag}`,
  phone: '+62811000000',
  email: undefined,
  nik: undefined,
  passportNo: undefined,
  passportExpiry: undefined,
  birthDate: undefined,
  gender: undefined,
  address: undefined,
  emergencyContact: undefined,
  notes: undefined,
});

test('Dietary defaults to REGULAR on fresh jemaah', async (t) => {
  const tag = makeTag('s210-default');
  const u = await tempJemaah(t, tag);
  const row = await db.jemaahProfile.findUnique({ where: { id: u.jemaah.id } });
  assert.equal(row.dietary, 'REGULAR');
  assert.equal(row.dietaryNotes, null);
});

test('META.DIETARIES exposes all 6 categories', () => {
  assert.deepEqual(META.DIETARIES, ['REGULAR', 'VEGETARIAN', 'HALAL_STRICT', 'SOFT_TEXTURE', 'DIABETIC', 'OTHER']);
});

test('JemaahSchema: dietary uppercased + dietaryNotes capped', () => {
  const v = JemaahSchema.parse({
    fullName: 'Test', phone: '+62811000000',
    dietary: 'vegetarian',
    dietaryNotes: 'no peanuts',
  });
  assert.equal(v.dietary, 'VEGETARIAN');
  assert.equal(v.dietaryNotes, 'no peanuts');
});

test('JemaahSchema 3-state: empty dietary → REGULAR clear; empty notes → null clear; absent → undefined', () => {
  // Both present but empty → explicit clear
  const cleared = JemaahSchema.parse({
    fullName: 'Test', phone: '+62811000000',
    dietary: '',
    dietaryNotes: '',
  });
  assert.equal(cleared.dietary, 'REGULAR');
  assert.equal(cleared.dietaryNotes, null);

  // Absent → no change signal
  const absent = JemaahSchema.parse({
    fullName: 'Test', phone: '+62811000000',
  });
  assert.equal(absent.dietary, undefined);
  assert.equal(absent.dietaryNotes, undefined);
});

test('JemaahSchema: invalid dietary rejected', () => {
  assert.throws(() => JemaahSchema.parse({
    fullName: 'Test', phone: '+62811000000',
    dietary: 'PIZZA',
  }));
});

test('updateJemaah: persists dietary + dietaryNotes', async (t) => {
  const tag = makeTag('s210-update');
  const u = await tempJemaah(t, tag);
  const actor = { id: 'sys', email: 'sys@test', role: 'OWNER' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  await updateJemaah({
    req, actor, jemaahId: u.jemaah.id,
    input: { ...baseInput(tag), dietary: 'DIABETIC', dietaryNotes: 'low sugar, no rice' },
  });

  const row = await db.jemaahProfile.findUnique({ where: { id: u.jemaah.id } });
  assert.equal(row.dietary, 'DIABETIC');
  assert.equal(row.dietaryNotes, 'low sugar, no rice');
});

test('updateJemaah: omitted dietary preserves prior value', async (t) => {
  const tag = makeTag('s210-omit');
  const u = await tempJemaah(t, tag);
  const actor = { id: 'sys', email: 'sys@test', role: 'OWNER' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  // Set to VEGETARIAN first
  await updateJemaah({
    req, actor, jemaahId: u.jemaah.id,
    input: { ...baseInput(tag), dietary: 'VEGETARIAN', dietaryNotes: 'soy ok' },
  });
  // Then update without dietary — should preserve
  await updateJemaah({
    req, actor, jemaahId: u.jemaah.id,
    input: { ...baseInput(tag), fullName: `Renamed ${tag}` },
  });

  const row = await db.jemaahProfile.findUnique({ where: { id: u.jemaah.id } });
  assert.equal(row.dietary, 'VEGETARIAN');
  assert.equal(row.dietaryNotes, 'soy ok');
  assert.equal(row.fullName, `Renamed ${tag}`);
});

test('updateJemaah: empty dietaryNotes string clears to NULL', async (t) => {
  const tag = makeTag('s210-clear');
  const u = await tempJemaah(t, tag);
  const actor = { id: 'sys', email: 'sys@test', role: 'OWNER' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  // Set to SOFT_TEXTURE with notes
  await updateJemaah({
    req, actor, jemaahId: u.jemaah.id,
    input: { ...baseInput(tag), dietary: 'SOFT_TEXTURE', dietaryNotes: 'puree only' },
  });
  // Clear notes only
  const validated = JemaahSchema.parse({
    fullName: `Test ${tag}`, phone: '+62811000000',
    dietaryNotes: '',
  });
  await updateJemaah({
    req, actor, jemaahId: u.jemaah.id,
    input: validated,
  });

  const row = await db.jemaahProfile.findUnique({ where: { id: u.jemaah.id } });
  // dietary preserved, notes cleared
  assert.equal(row.dietary, 'SOFT_TEXTURE');
  assert.equal(row.dietaryNotes, null);
});
