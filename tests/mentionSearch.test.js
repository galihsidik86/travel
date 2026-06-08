import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempJemaah, tempMuthawwif } from './_helpers.js';
import { searchStaffForMention } from '../src/services/userAdmin.js';

test('searchStaffForMention: returns [] when q is empty', async () => {
  assert.deepEqual(await searchStaffForMention({}), []);
  assert.deepEqual(await searchStaffForMention({ q: '' }), []);
  assert.deepEqual(await searchStaffForMention({ q: 'a' }), []);
});

test('searchStaffForMention: matches email + fullName substring', async (t) => {
  const tag = makeTag('ms-match');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const byEmail = await searchStaffForMention({ q: tag });
  const byName = await searchStaffForMention({ q: u.fullName.split(' ')[0] });

  assert.ok(byEmail.some((r) => r.id === u.id), 'should find by email substring');
  assert.ok(byName.some((r) => r.id === u.id), 'should find by fullName substring');
});

test('searchStaffForMention: excludes JEMAAH + AGEN + MUTHAWWIF', async (t) => {
  const tag = makeTag('ms-excl');
  const j = await tempJemaah(t, tag);
  const m = await tempMuthawwif(t, tag);

  // Search by the tag — both fixtures have it in their email.
  const rows = await searchStaffForMention({ q: tag });
  assert.ok(!rows.some((r) => r.id === j.id), 'JEMAAH must NOT be mentionable');
  assert.ok(!rows.some((r) => r.id === m.id), 'MUTHAWWIF must NOT be mentionable');
});

test('searchStaffForMention: excludes SUSPENDED + soft-deleted', async (t) => {
  const tag = makeTag('ms-state');
  const live = await tempUser(t, `${tag}-l`, { role: 'OWNER' });
  const suspended = await tempUser(t, `${tag}-s`, { role: 'OWNER', status: 'SUSPENDED' });

  const rows = await searchStaffForMention({ q: tag });
  assert.ok(rows.some((r) => r.id === live.id));
  assert.ok(!rows.some((r) => r.id === suspended.id), 'SUSPENDED must NOT appear');
});

test('searchStaffForMention: caps result at 10', async (t) => {
  const tag = makeTag('ms-cap');
  // Create 12 OWNER users sharing the same tag prefix.
  for (let i = 0; i < 12; i += 1) {
    await tempUser(t, `${tag}-${i}`, { role: 'OWNER' });
  }
  const rows = await searchStaffForMention({ q: tag });
  assert.ok(rows.length <= 10, 'cap at 10, got ' + rows.length);
});
