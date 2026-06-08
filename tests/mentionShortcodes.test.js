import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { updateBookingNotes } from '../src/services/bookingAdmin.js';
import { createShortcode, deleteShortcode, listShortcodes } from '../src/services/mentionShortcodes.js';
import { HttpError } from '../src/middleware/error.js';

test('createShortcode: rejects bad code shape', async (t) => {
  const tag = makeTag('sc-bad');
  const owner = await tempUser(t, `${tag}-o`, { role: 'OWNER' });

  // Bad shapes: spaces, dots, special chars, too long. Uppercase is OK —
  // createShortcode lowercases before validating (admin-friendly).
  for (const bad of ['has space', 'has.dot', 'has!bang', 'too-long-' + 'x'.repeat(40)]) {
    await assert.rejects(
      () => createShortcode({ req: fakeReq, actor: { id: owner.id, email: owner.email, role: 'OWNER' }, code: bad, userId: owner.id }),
      (err) => err instanceof HttpError && err.code === 'BAD_CODE',
    );
  }
});

test('createShortcode: rejects non-staff targets', async (t) => {
  const tag = makeTag('sc-nonstaff');
  const j = await tempJemaah(t, tag);
  const actor = await tempUser(t, `${tag}-a`, { role: 'OWNER' });

  await assert.rejects(
    () => createShortcode({ req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' }, code: 'cs-' + tag, userId: j.id }),
    (err) => err instanceof HttpError && err.code === 'NOT_STAFF',
  );
});

test('createShortcode: rejects duplicate code', async (t) => {
  const tag = makeTag('sc-dup');
  const u = await tempUser(t, `${tag}-u`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const code = 'd-' + tag.replace(/[^a-z0-9]/g, '').slice(0, 30);

  const created = await createShortcode({
    req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    code, userId: u.id,
  });
  t.after(() => db.mentionShortcode.deleteMany({ where: { id: created.id } }));

  await assert.rejects(
    () => createShortcode({
      req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' },
      code, userId: u.id,
    }),
    (err) => err instanceof HttpError && err.code === 'CODE_EXISTS',
  );
});

test('updateBookingNotes: :code expands to @user.email at save', async (t) => {
  const tag = makeTag('sc-exp');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });
  const code = 'x-' + tag.replace(/[^a-z0-9]/g, '').slice(0, 30);

  const sc = await createShortcode({
    req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    code, userId: target.id,
  });
  t.after(async () => {
    await db.mentionShortcode.deleteMany({ where: { id: sc.id } });
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `please follow up :${code} ASAP`,
  });

  // Stored notes should now contain the expanded @email — not the :code
  const stored = await db.booking.findUnique({ where: { id: booking.id }, select: { notes: true } });
  assert.ok(stored.notes.includes('@' + target.email), 'notes should contain @user.email after expansion');
  assert.ok(!stored.notes.includes(':' + code), ':code should be replaced');

  // BookingMention row should reflect the expanded user
  const mentions = await db.bookingMention.findMany({ where: { bookingId: booking.id } });
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].userEmail, target.email);
});

test('updateBookingNotes: unknown :code is left as-is (visible to admin)', async (t) => {
  const tag = makeTag('sc-unknown');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `ping :nonexistent-code-${tag}`,
  });

  const stored = await db.booking.findUnique({ where: { id: booking.id }, select: { notes: true } });
  assert.ok(stored.notes.includes(':nonexistent-code-'), 'unknown code remains visible');
});

test('updateBookingNotes: :code targeting suspended user is left as-is', async (t) => {
  const tag = makeTag('sc-suspended');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER', status: 'SUSPENDED' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });
  const code = 'sus-' + tag.replace(/[^a-z0-9]/g, '').slice(0, 30);

  // createShortcode would reject SUSPENDED via the staff list (it filters
  // STATUS=ACTIVE in listStaffForShortcode but createShortcode itself only
  // checks role + delete state). So create via direct DB insert to model
  // "target was active when code was set up, then later suspended".
  const sc = await db.mentionShortcode.create({
    data: { code, userId: target.id, createdById: actor.id },
  });
  t.after(async () => {
    await db.mentionShortcode.deleteMany({ where: { id: sc.id } });
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `note :${code}`,
  });

  const stored = await db.booking.findUnique({ where: { id: booking.id }, select: { notes: true } });
  assert.ok(stored.notes.includes(':' + code), 'suspended target → code stays as-is');
  assert.ok(!stored.notes.includes('@' + target.email), 'should NOT expand to suspended user');
});

test('deleteShortcode: 404 on unknown id', async () => {
  await assert.rejects(
    () => deleteShortcode({ req: fakeReq, actor: { id: 'sys', email: 'sys', role: 'OWNER' }, id: 'nope-id-xyz' }),
    (err) => err instanceof HttpError && err.code === 'SHORTCUT_NOT_FOUND',
  );
});

test('listShortcodes: returns alphabetical with user populated', async (t) => {
  const tag = makeTag('sc-list');
  const u = await tempUser(t, `${tag}-u`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-a`, { role: 'OWNER' });
  const code = 'l-' + tag.replace(/[^a-z0-9]/g, '').slice(0, 30);

  const sc = await createShortcode({
    req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    code, userId: u.id,
  });
  t.after(() => db.mentionShortcode.deleteMany({ where: { id: sc.id } }));

  const list = await listShortcodes();
  const mine = list.find((s) => s.id === sc.id);
  assert.ok(mine);
  assert.equal(mine.user?.email, u.email);
});
