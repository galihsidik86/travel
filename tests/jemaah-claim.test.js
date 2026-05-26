// Jemaah-side lifecycle tests:
//   - claimBooking with soft-merge (5p.2): generic 404, idempotency,
//     profile-merge (user wins on conflict), source delete when orphaned
//   - requestCancelByJemaah (5ff): flag set, admin cancel clears it,
//     duplicate request refused
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { claimBooking, requestCancelByJemaah } from '../src/services/jemaahPortal.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

describe('claimBooking — match rules + generic 404', () => {
  test('unknown bookingNo → CLAIM_MISMATCH (anti-enumeration)', async (t) => {
    const tag = makeTag('claim-nobook');
    const user = await tempJemaah(t, tag);
    await assert.rejects(
      claimBooking({
        ...ctx,
        actor: { id: user.id, email: user.email, role: user.role },
        userId: user.id,
        bookingNo: 'RP-NOPE-99999',
        phone: '+62811',
      }),
      (err) => err.code === 'CLAIM_MISMATCH',
    );
  });

  test('phone mismatch → CLAIM_MISMATCH (same generic error as missing booking)', async (t) => {
    const tag = makeTag('claim-phone');
    const claimer = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const anonProfile = await db.jemaahProfile.create({
      data: { fullName: 'Walk-in Test', phone: '+628999999999' },
    });
    t.after(async () => {
      // Defensive: drop bookings referencing this anon profile before
      // dropping the profile itself (FK).
      await db.booking.deleteMany({ where: { jemaahId: anonProfile.id } });
      await db.jemaahProfile.deleteMany({ where: { id: anonProfile.id } });
    });
    const booking = await tempBooking({ paket, jemaahProfileId: anonProfile.id });

    await assert.rejects(
      claimBooking({
        ...ctx,
        actor: { id: claimer.id, email: claimer.email, role: claimer.role },
        userId: claimer.id,
        bookingNo: booking.bookingNo,
        phone: '+62888-different',
      }),
      (err) => err.code === 'CLAIM_MISMATCH',
    );
  });

  test('phone match strips spaces/dashes/parens (but does NOT do +62↔08 conversion)', async (t) => {
    // normalizePhone in claimBooking only strips formatting chars; it doesn't
    // canonicalise country code. The stored "+62..." form and a user-typed
    // "+62..." with different separators must match digit-for-digit after strip.
    const tag = makeTag('claim-fmt');
    const claimer = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const anonProfile = await db.jemaahProfile.create({
      data: { fullName: 'Walk-in', phone: '+62 (812) 3456-7890' },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: anonProfile.id } }));
    const booking = await tempBooking({ paket, jemaahProfileId: anonProfile.id });

    const result = await claimBooking({
      ...ctx,
      actor: { id: claimer.id, email: claimer.email, role: claimer.role },
      userId: claimer.id,
      bookingNo: booking.bookingNo,
      phone: '+62-812-3456 7890', // different separators, same digits + same +62 prefix
    });
    assert.equal(result.booking.jemaahUserId, claimer.id);
  });

  test('already claimed by SAME user → idempotent', async (t) => {
    const tag = makeTag('claim-idem');
    const claimer = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: claimer.jemaah.id, jemaahUserId: claimer.id,
    });

    const result = await claimBooking({
      ...ctx,
      actor: { id: claimer.id, email: claimer.email, role: claimer.role },
      userId: claimer.id,
      bookingNo: booking.bookingNo,
      phone: claimer.phone,
    });
    assert.equal(result.alreadyClaimed, true, 'idempotent for same user');
  });

  test('already claimed by DIFFERENT user → 409 CLAIM_TAKEN', async (t) => {
    const tag = makeTag('claim-taken');
    const ownerUser = await tempJemaah(t, `${tag}-owner`);
    const thief = await tempJemaah(t, `${tag}-thief`);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: ownerUser.jemaah.id, jemaahUserId: ownerUser.id,
    });

    await assert.rejects(
      claimBooking({
        ...ctx,
        actor: { id: thief.id, email: thief.email, role: thief.role },
        userId: thief.id,
        bookingNo: booking.bookingNo,
        phone: thief.phone, // same phone since helper uses fixed string
      }),
      (err) => err.code === 'CLAIM_TAKEN',
    );
  });
});

describe('claimBooking — soft-merge profile (5p.2)', () => {
  test('booking re-pointed; non-@unique fields copied; source orphan deleted', async (t) => {
    const tag = makeTag('claim-merge');
    const user = await tempJemaah(t, tag);
    // User's profile starts empty for everything. Source has non-@unique
    // fields. (NIK/passport are tested separately below — they have a
    // defensive skip behavior worth isolating.)
    const sourceProfile = await db.jemaahProfile.create({
      data: {
        fullName: 'Walk-in Person', phone: user.phone,
        birthDate: new Date('1980-05-15'),
        gender: 'L',
        address: 'Jl. Sumber',
        emergencyContact: 'Istri 0813',
        notes: 'preferred vegetarian meals',
      },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: sourceProfile.id } }));

    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: sourceProfile.id });

    const result = await claimBooking({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingNo: booking.bookingNo,
      phone: user.phone,
    });
    assert.equal(result.merged, true, 'merge happened');

    // Booking re-pointed
    const afterBooking = await db.booking.findUnique({
      where: { id: booking.id }, select: { jemaahId: true, jemaahUserId: true },
    });
    assert.equal(afterBooking.jemaahId, user.jemaah.id);
    assert.equal(afterBooking.jemaahUserId, user.id);

    // Non-@unique fields copied
    const afterUserProfile = await db.jemaahProfile.findUnique({ where: { id: user.jemaah.id } });
    assert.equal(afterUserProfile.address, 'Jl. Sumber');
    assert.equal(afterUserProfile.emergencyContact, 'Istri 0813');
    assert.equal(afterUserProfile.notes, 'preferred vegetarian meals');
    assert.equal(afterUserProfile.gender, 'L');
    assert.ok(afterUserProfile.birthDate, 'birthDate copied');

    // Source profile deleted (no more bookings reference it)
    const orphan = await db.jemaahProfile.findUnique({ where: { id: sourceProfile.id } });
    assert.equal(orphan, null, 'orphaned source profile deleted');
  });

  test('@unique fields (nik/passportNo) DO transfer when source becomes orphan', async (t) => {
    // Uniquely tagged values so this test is isolated from any seeded data.
    const nik = `9${Date.now()}`.slice(0, 16);
    const passportNo = `T${Date.now()}`.slice(0, 9);
    const tag = makeTag('claim-unique-transfer');
    const user = await tempJemaah(t, tag);
    const sourceProfile = await db.jemaahProfile.create({
      data: { fullName: 'Transfers', phone: user.phone, nik, passportNo },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: sourceProfile.id } }));

    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: sourceProfile.id });
    await claimBooking({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingNo: booking.bookingNo, phone: user.phone,
    });

    const after = await db.jemaahProfile.findUnique({ where: { id: user.jemaah.id } });
    assert.equal(after.nik, nik, 'NIK transferred (source was orphaned + deleted)');
    assert.equal(after.passportNo, passportNo, 'passportNo transferred');
    // Source profile deleted, so @unique on these values is free
    const sourceAfter = await db.jemaahProfile.findUnique({ where: { id: sourceProfile.id } });
    assert.equal(sourceAfter, null, 'source profile gone — @unique was freed by null-then-delete');
  });

  test('@unique NOT transferred when source survives (still has other bookings)', async (t) => {
    // If source still has other bookings, we can't take its @unique value
    // away — those other booking-profiles would lose the data. So we skip
    // the copy. This preserves data integrity for shared source profiles.
    const nik = `8${Date.now()}`.slice(0, 16);
    const tag = makeTag('claim-unique-survive');
    const user = await tempJemaah(t, tag);
    const sourceProfile = await db.jemaahProfile.create({
      data: { fullName: 'Survives', phone: user.phone, nik },
    });
    t.after(async () => {
      await db.booking.deleteMany({ where: { jemaahId: sourceProfile.id } });
      await db.jemaahProfile.deleteMany({ where: { id: sourceProfile.id } });
    });

    const paket = await tempPaket(t, tag);
    const claimBk = await tempBooking({ paket, jemaahProfileId: sourceProfile.id });
    // 2nd booking keeps source alive after claim
    await tempBooking({ paket, jemaahProfileId: sourceProfile.id });

    await claimBooking({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingNo: claimBk.bookingNo, phone: user.phone,
    });

    const userAfter = await db.jemaahProfile.findUnique({ where: { id: user.jemaah.id } });
    const sourceAfter = await db.jemaahProfile.findUnique({ where: { id: sourceProfile.id } });
    assert.equal(userAfter.nik, null, 'NIK NOT copied — source survives, must keep it');
    assert.equal(sourceAfter.nik, nik, 'source still owns NIK');
  });


  test('user wins on conflict — existing fields NOT overwritten', async (t) => {
    const tag = makeTag('claim-userwins');
    const user = await tempJemaah(t, tag);
    // User's profile already has NIK + address
    await db.jemaahProfile.update({
      where: { id: user.jemaah.id },
      data: { nik: '9999999999999999', address: 'Jl. Yang Pertama' },
    });

    // Source profile has DIFFERENT NIK + address (no passport — that case is
    // covered by the "copy missing" test in the previous block).
    const sourceProfile = await db.jemaahProfile.create({
      data: {
        fullName: 'Source', phone: user.phone,
        nik: '1111111111111111',
        address: 'Jl. Yang Kedua',
      },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: sourceProfile.id } }));

    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: sourceProfile.id });

    await claimBooking({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingNo: booking.bookingNo,
      phone: user.phone,
    });

    const after = await db.jemaahProfile.findUnique({ where: { id: user.jemaah.id } });
    assert.equal(after.nik, '9999999999999999', 'user NIK preserved');
    assert.equal(after.address, 'Jl. Yang Pertama', 'user address preserved');
  });

  test('source profile kept if it still has other bookings', async (t) => {
    const tag = makeTag('claim-keep-source');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    // Register paket FIRST so its cleanup (cascading bookings) runs before
    // we try to delete the sourceProfile. Order matters: t.after is FIFO.
    const sourceProfile = await db.jemaahProfile.create({
      data: { fullName: 'Multi-booking source', phone: user.phone },
    });
    t.after(async () => {
      // Defensive: drop any bookings still pointing at the source before
      // dropping the profile (FK).
      await db.booking.deleteMany({ where: { jemaahId: sourceProfile.id } });
      await db.jemaahProfile.deleteMany({ where: { id: sourceProfile.id } });
    });

    const bookingClaim = await tempBooking({ paket, jemaahProfileId: sourceProfile.id });
    // 2nd booking under the same source → keeps source alive
    await tempBooking({ paket, jemaahProfileId: sourceProfile.id });

    await claimBooking({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingNo: bookingClaim.bookingNo,
      phone: user.phone,
    });

    const stillThere = await db.jemaahProfile.findUnique({ where: { id: sourceProfile.id } });
    assert.ok(stillThere, 'source profile preserved (2nd booking still references it)');
  });
});

describe('requestCancelByJemaah (5ff)', () => {
  test('sets cancel-request flags + admin cancel clears them', async (t) => {
    const tag = makeTag('reqcancel');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id,
    });

    await requestCancelByJemaah({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id,
      bookingId: booking.id,
      reason: 'pribadi mendesak',
    });

    const flagged = await db.booking.findUnique({
      where: { id: booking.id },
      select: { status: true, cancelRequested: true, cancelRequestedAt: true, cancelRequestReason: true },
    });
    assert.equal(flagged.cancelRequested, true);
    assert.equal(flagged.cancelRequestReason, 'pribadi mendesak');
    assert.ok(flagged.cancelRequestedAt);
    assert.equal(flagged.status, 'PENDING', 'status NOT changed — admin still has to approve');

    // Admin cancels — clears the request flags as part of the same transaction
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'approved per jemaah request' });
    const after = await db.booking.findUnique({
      where: { id: booking.id },
      select: { status: true, cancelRequested: true, cancelRequestedAt: true, cancelRequestReason: true },
    });
    assert.equal(after.status, 'CANCELLED');
    assert.equal(after.cancelRequested, false, 'request flag cleared on cancel');
    assert.equal(after.cancelRequestedAt, null);
    assert.equal(after.cancelRequestReason, null);
  });

  test('refuses duplicate request while one is pending', async (t) => {
    const tag = makeTag('reqcancel-dupe');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id,
    });

    await requestCancelByJemaah({
      ...ctx,
      actor: { id: user.id, email: user.email, role: user.role },
      userId: user.id, bookingId: booking.id, reason: 'first ask',
    });
    await assert.rejects(
      requestCancelByJemaah({
        ...ctx,
        actor: { id: user.id, email: user.email, role: user.role },
        userId: user.id, bookingId: booking.id, reason: 'second ask',
      }),
      (err) => err.code === 'ALREADY_REQUESTED',
    );
  });

  test('refuses on CANCELLED / REFUNDED booking', async (t) => {
    const tag = makeTag('reqcancel-closed');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id,
    });
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'pre-cancel' });

    await assert.rejects(
      requestCancelByJemaah({
        ...ctx,
        actor: { id: user.id, email: user.email, role: user.role },
        userId: user.id, bookingId: booking.id, reason: 'too late',
      }),
      (err) => err.code === 'ALREADY_CLOSED',
    );
  });

  test('refuses reason < 3 chars', async (t) => {
    const tag = makeTag('reqcancel-reason');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id,
    });
    await assert.rejects(
      requestCancelByJemaah({
        ...ctx,
        actor: { id: user.id, email: user.email, role: user.role },
        userId: user.id, bookingId: booking.id, reason: 'no',
      }),
      (err) => err.code === 'CANCEL_REASON_REQUIRED',
    );
  });

  test('refuses cross-user attempt (booking owned by someone else)', async (t) => {
    const tag = makeTag('reqcancel-cross');
    const owner = await tempJemaah(t, `${tag}-o`);
    const stranger = await tempJemaah(t, `${tag}-s`);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({
      paket, jemaahProfileId: owner.jemaah.id, jemaahUserId: owner.id,
    });

    await assert.rejects(
      requestCancelByJemaah({
        ...ctx,
        actor: { id: stranger.id, email: stranger.email, role: stranger.role },
        userId: stranger.id, bookingId: booking.id, reason: 'not mine',
      }),
      (err) => err.code === 'BOOKING_NOT_FOUND',
    );
  });
});
