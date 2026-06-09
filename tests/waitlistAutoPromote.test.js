// Stage 136 — cancelBooking auto-promotes a verified WAITING waitlist
// entry when seats are freed. Verified = active JEMAAH user with ≥1
// prior LUNAS booking. Skips the S42 nudge when auto-promote fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempPaket, tempJemaah, tempBooking, fakeReq } from './_helpers.js';
import { findVerifiedWaitlistForPaket } from '../src/services/waitlist.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

// Helper: build a verified JEMAAH (with a prior LUNAS booking under
// a DIFFERENT paket so we don't interfere with the current test paket).
async function makeVerifiedJemaah(t, tag, phone) {
  const user = await tempJemaah(t, tag);
  // Override phone so the waitlist match works
  await db.jemaahProfile.update({
    where: { id: user.jemaah.id },
    data: { phone },
  });
  // Seed a prior LUNAS booking under its OWN paket
  const priorPaket = await tempPaket(t, `${tag}-prior`);
  await tempBooking({ paket: priorPaket, jemaahProfileId: user.jemaah.id, totalAmount: '1000000' });
  // Flip the prior booking to LUNAS so the trust signal kicks in
  await db.booking.updateMany({
    where: { jemaahId: user.jemaah.id },
    data: { status: 'LUNAS', paidAmount: '1000000' },
  });
  return user;
}

test('findVerifiedWaitlistForPaket: returns null when waitlist is empty', async (t) => {
  const tag = makeTag('s136-empty');
  const paket = await tempPaket(t, tag);
  const r = await findVerifiedWaitlistForPaket({ paketId: paket.id });
  assert.equal(r, null);
});

test('findVerifiedWaitlistForPaket: skips entries whose phone has no JEMAAH user', async (t) => {
  const tag = makeTag('s136-noUser');
  const paket = await tempPaket(t, tag);

  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Random Person', phone: '+62-999-9999', status: 'WAITING' },
  });
  t.after(() => db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }));

  const r = await findVerifiedWaitlistForPaket({ paketId: paket.id });
  assert.equal(r, null);
});

test('findVerifiedWaitlistForPaket: skips JEMAAH users with zero prior LUNAS', async (t) => {
  const tag = makeTag('s136-noLunas');
  const paket = await tempPaket(t, tag);
  // Create a JEMAAH with profile + matching phone but NO LUNAS history
  const user = await tempJemaah(t, tag);
  const phone = '+62-822-1234-5678';
  await db.jemaahProfile.update({
    where: { id: user.jemaah.id },
    data: { phone },
  });
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Unverified', phone, status: 'WAITING' },
  });
  t.after(() => db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }));

  const r = await findVerifiedWaitlistForPaket({ paketId: paket.id });
  assert.equal(r, null, 'no prior LUNAS = not verified');
});

test('findVerifiedWaitlistForPaket: returns oldest verified row', async (t) => {
  const tag = makeTag('s136-find');
  const paket = await tempPaket(t, tag);
  const phone = '+62-822-9999-0000';
  const verified = await makeVerifiedJemaah(t, tag, phone);

  // Add an UNverified row created FIRST (older), then verified row
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Cold', phone: '+62-700-0000-0000', status: 'WAITING' },
  });
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Trusted', phone, status: 'WAITING' },
  });
  t.after(() => db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }));

  const r = await findVerifiedWaitlistForPaket({ paketId: paket.id });
  assert.ok(r);
  assert.equal(r.user.email, verified.email);
  assert.ok(r.priorLunasCount >= 1);
  assert.equal(r.waitlist.phone, phone);
});

test('cancelBooking: auto-promotes verified waitlist + skips notif nudge', async (t) => {
  const tag = makeTag('s136-cancel');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  // Source booking to cancel (frees 2 QUAD seats)
  const sourceJem = await tempJemaah(t, `${tag}-src`);
  const sourceBooking = await tempBooking({
    paket, jemaahProfileId: sourceJem.jemaah.id, totalAmount: '1000000',
  });
  // Bump paket.kursiTerisi to simulate the source occupying 2 seats
  await db.paket.update({
    where: { id: paket.id }, data: { kursiTerisi: 5, kursiTotal: 10 },
  });
  await db.booking.update({
    where: { id: sourceBooking.id },
    data: { kelas: 'QUAD', paxCount: 2 },
  });

  // Verified jemaah on waitlist
  const phone = '+62-822-1111-2222';
  const verified = await makeVerifiedJemaah(t, `${tag}-v`, phone);
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Trusted Jemaah', phone, status: 'WAITING' },
  });
  t.after(() => db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }));
  // Cleanup any auto-promoted booking + its profile rows
  t.after(async () => {
    await db.booking.deleteMany({
      where: { paketId: paket.id, jemaahId: { not: sourceJem.jemaah.id } },
    });
  });

  await cancelBooking({
    req: fakeReq, actor: actor(owner),
    bookingId: sourceBooking.id,
    reason: 'test auto-promote',
  });

  // Waitlist row flipped to PROMOTED
  const after = await db.paketWaitlist.findFirst({
    where: { paketId: paket.id, phone },
  });
  assert.equal(after.status, 'PROMOTED');
  assert.ok(after.promotedBookingId, 'promoted booking ref stamped');

  // No WAITLIST_SLOT_FREED notif enqueued (S42 nudge skipped)
  const nudges = await db.notification.findMany({
    where: { type: 'WAITLIST_SLOT_FREED', payload: { path: '$.paketId', equals: paket.id } },
  });
  assert.equal(nudges.length, 0, 'S42 nudge skipped when auto-promote happened');

  // Auto-promote audit row stamped
  const auditRows = await db.auditLog.findMany({
    where: { entity: 'PaketWaitlist', entityId: after.id },
  });
  const autoMark = auditRows.find((r) => r.after?.autoPromoted === true);
  assert.ok(autoMark, 'auto-promote audit row present');
  assert.equal(autoMark.after.verifiedSignal.userEmail, verified.email);
});

test('cancelBooking: no verified candidate → falls back to S42 nudge', async (t) => {
  const tag = makeTag('s136-fallback');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const sourceJem = await tempJemaah(t, `${tag}-src`);
  const sourceBooking = await tempBooking({
    paket, jemaahProfileId: sourceJem.jemaah.id, totalAmount: '1000000',
  });
  // Unverified candidate (no JEMAAH account + no LUNAS history)
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Cold Lead', phone: '+62-700-1234', status: 'WAITING' },
  });
  t.after(() => db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }));
  t.after(() => db.notification.deleteMany({
    where: { type: 'WAITLIST_SLOT_FREED', payload: { path: '$.paketId', equals: paket.id } },
  }));

  await cancelBooking({
    req: fakeReq, actor: actor(owner),
    bookingId: sourceBooking.id,
    reason: 'test fallback',
  });

  // Waitlist row stays WAITING (no auto-promote)
  const after = await db.paketWaitlist.findFirst({
    where: { paketId: paket.id, phone: '+62-700-1234' },
  });
  assert.equal(after.status, 'WAITING');

  // S42 nudge fired (at least one notif enqueued to an admin)
  const nudges = await db.notification.findMany({
    where: { type: 'WAITLIST_SLOT_FREED', payload: { path: '$.paketId', equals: paket.id } },
  });
  assert.ok(nudges.length >= 1, 'S42 nudge fires when no auto-promote');
});
