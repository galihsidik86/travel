// Stage 206 — toggle the pinned-banner flag for booking notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { toggleBookingNotesPinned, updateBookingNotes } from '../src/services/bookingAdmin.js';

test('toggleBookingNotesPinned: unknown booking → BOOKING_NOT_FOUND', async () => {
  await assert.rejects(
    toggleBookingNotesPinned({
      req: fakeReq, actor: systemActor,
      bookingId: 'does-not-exist', pinned: true,
    }),
    /BOOKING_NOT_FOUND|tidak ditemukan/,
  );
});

test('toggleBookingNotesPinned: empty notes → EMPTY_NOTES on pin=true', async (t) => {
  const tag = makeTag('s206-empty');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await assert.rejects(
    toggleBookingNotesPinned({
      req: fakeReq, actor: systemActor,
      bookingId: b.id, pinned: true,
    }),
    /EMPTY_NOTES|Tidak ada catatan/,
  );
});

test('toggleBookingNotesPinned: pin=false on empty notes → no-op', async (t) => {
  const tag = makeTag('s206-empty-unpin');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Should succeed (no notes, already not pinned, unpin is no-op)
  const r = await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: false,
  });
  assert.equal(r.updated, false);
});

test('toggleBookingNotesPinned: pin → flips + audit', async (t) => {
  const tag = makeTag('s206-pin');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Set notes first
  await updateBookingNotes({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, notes: 'VIP — handle personally',
  });
  const r = await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: true,
  });
  assert.equal(r.updated, true);
  assert.equal(r.booking.notesPinned, true);

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(audits[0].after.field, 'notesPinned');
  assert.equal(audits[0].after.notesPinned, true);
});

test('toggleBookingNotesPinned: idempotent when already pinned', async (t) => {
  const tag = makeTag('s206-idem');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await updateBookingNotes({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, notes: 'important note',
  });
  await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: true,
  });
  // Re-pin → no-op
  const r = await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: true,
  });
  assert.equal(r.updated, false);
});

test('toggleBookingNotesPinned: unpin works after pin', async (t) => {
  const tag = makeTag('s206-unpin');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await updateBookingNotes({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, notes: 'note text',
  });
  await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: true,
  });
  const r = await toggleBookingNotesPinned({
    req: fakeReq, actor: systemActor,
    bookingId: b.id, pinned: false,
  });
  assert.equal(r.updated, true);
  assert.equal(r.booking.notesPinned, false);
});
