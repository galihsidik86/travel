import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { updateBookingNotes, extractMentionEmails } from '../src/services/bookingAdmin.js';

test('extractMentionEmails: parses @email tokens', () => {
  const text = 'cek dengan @ops@religio.pro juga @finance@religio.pro pls';
  const out = extractMentionEmails(text);
  assert.deepEqual(out.sort(), ['finance@religio.pro', 'ops@religio.pro']);
});

test('extractMentionEmails: ignores stray @ inside email-like substrings', () => {
  // "user@example.com" has no leading whitespace + leading-@ so it's NOT a mention.
  const text = 'send to user@example.com later';
  const out = extractMentionEmails(text);
  assert.deepEqual(out, []);
});

test('extractMentionEmails: dedupes and lowercases', () => {
  const text = '@Foo@Bar.com please update @foo@bar.com also @other@x.io';
  const out = extractMentionEmails(text).sort();
  assert.deepEqual(out, ['foo@bar.com', 'other@x.io']);
});

test('updateBookingNotes: fires notif for new @-mentions only', async (t) => {
  const tag = makeTag('mention');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });

  const owner = await tempUser(t, `${tag}-mentioned`, { role: 'OWNER' });

  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  // First write — introduces the mention.
  await updateBookingNotes({
    req: fakeReq,
    actor: { id: 'system', email: 'cs@religio.pro', role: 'OWNER' },
    bookingId: booking.id,
    notes: `customer butuh follow-up, @${owner.email} bisa ambil?`,
  });

  let notifs = await db.notification.findMany({
    where: { type: 'BOOKING_NOTE_MENTION', relatedEntityId: booking.id, recipientEmail: owner.email },
  });
  assert.equal(notifs.length, 1, 'first mention should fire exactly one notif');

  // Second write — same mention + extra context; should NOT re-fire.
  await updateBookingNotes({
    req: fakeReq,
    actor: { id: 'system', email: 'cs@religio.pro', role: 'OWNER' },
    bookingId: booking.id,
    notes: `customer butuh follow-up, @${owner.email} bisa ambil? update: sudah dihub jam 14`,
  });

  notifs = await db.notification.findMany({
    where: { type: 'BOOKING_NOTE_MENTION', relatedEntityId: booking.id, recipientEmail: owner.email },
  });
  assert.equal(notifs.length, 1, 'existing mention must not re-fire on text change');
});

test('updateBookingNotes: skips actor self-mention', async (t) => {
  const tag = makeTag('mention-self');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });

  const actorUser = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actorUser.id, email: actorUser.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `noted by @${actorUser.email}`,
  });

  const notifs = await db.notification.findMany({
    where: { type: 'BOOKING_NOTE_MENTION', relatedEntityId: booking.id },
  });
  assert.equal(notifs.length, 0, 'self-mention should be silently skipped');
});

test('updateBookingNotes: unknown email mention enqueues nothing', async (t) => {
  const tag = makeTag('mention-ghost');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });

  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: 'system', email: 'cs@religio.pro', role: 'OWNER' },
    bookingId: booking.id,
    notes: `please ping @ghost-${tag}@nope.test about this`,
  });

  const notifs = await db.notification.findMany({
    where: { type: 'BOOKING_NOTE_MENTION', relatedEntityId: booking.id },
  });
  assert.equal(notifs.length, 0, 'unknown email should silently no-op');
});

test('updateBookingNotes: no-op when notes unchanged — no audit, no notif', async (t) => {
  const tag = makeTag('mention-noop');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const owner = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });

  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  const notes = `please review @${owner.email}`;

  await updateBookingNotes({
    req: fakeReq, actor: { id: 'system', email: 'cs@religio.pro', role: 'OWNER' },
    bookingId: booking.id, notes,
  });
  const firstAudits = await db.auditLog.count({ where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' } });

  // Second identical write — should be a no-op.
  await updateBookingNotes({
    req: fakeReq, actor: { id: 'system', email: 'cs@religio.pro', role: 'OWNER' },
    bookingId: booking.id, notes,
  });
  const secondAudits = await db.auditLog.count({ where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' } });

  assert.equal(secondAudits, firstAudits, 'no-op call must not write a second audit row');
});
