// Stage 141 — per-jemaah nudge when manifest closes < 72h AND
// required docs missing. Idempotent via Booking.manifestCloseNotifiedAt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  getManifestCloseNudgeCandidates, computeMissingRequired,
} from '../src/services/manifestCloseNudge.js';
import { notifyManifestCloseNudge } from '../src/services/notifications.js';

test('computeMissingRequired: empty profile → all 4 missing', () => {
  const missing = computeMissingRequired({
    passportNo: null, emergencyContact: null, documents: [],
  });
  assert.equal(missing.length, 4);
  assert.ok(missing.includes('Nomor paspor'));
  assert.ok(missing.includes('Visa umroh'));
  assert.ok(missing.includes('Sertifikat vaksin meningitis'));
  assert.ok(missing.includes('Kontak darurat'));
});

test('computeMissingRequired: fully prepared → empty list', () => {
  const missing = computeMissingRequired({
    passportNo: 'X12345',
    emergencyContact: 'Wife · +62812',
    documents: [
      { type: 'VISA_UMROH', status: 'VERIFIED' },
      { type: 'VACCINE_MENINGITIS', status: 'VERIFIED' },
    ],
  });
  assert.deepEqual(missing, []);
});

test('computeMissingRequired: visa SUBMITTED but not VERIFIED → still missing', () => {
  const missing = computeMissingRequired({
    passportNo: 'X12345',
    emergencyContact: 'Wife',
    documents: [{ type: 'VISA_UMROH', status: 'SUBMITTED' }],
  });
  assert.ok(missing.includes('Visa umroh'));
  assert.ok(missing.includes('Sertifikat vaksin meningitis'));
});

test('getManifestCloseNudgeCandidates: paket with no manifestClosesAt → ignored', async (t) => {
  const tag = makeTag('s141-noclose');
  const paket = await tempPaket(t, tag);
  // paket has manifestClosesAt=null by default
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getManifestCloseNudgeCandidates({ now: new Date(), windowHours: 72 });
  const matched = r.rows.filter((x) => x.paket.id === paket.id);
  assert.equal(matched.length, 0, 'no close date → not a candidate');
});

test('getManifestCloseNudgeCandidates: within 72h + missing docs → candidate', async (t) => {
  const tag = makeTag('s141-within');
  const paket = await tempPaket(t, tag);
  // Manifest closes in 48h
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  // Jemaah profile has no passport, no emergency contact, no docs → all missing
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getManifestCloseNudgeCandidates({ now: new Date(), windowHours: 72 });
  const matched = r.rows.find((x) => x.bookingId === booking.id);
  assert.ok(matched, 'in-window booking with missing docs → candidate');
  assert.ok(matched.missing.length >= 1);
  assert.equal(matched.overdue, false);
});

test('getManifestCloseNudgeCandidates: complete jemaah → excluded even when close is near', async (t) => {
  const tag = makeTag('s141-complete');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  // Fully prepared
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { passportNo: 'X12345', emergencyContact: 'Wife · +62812' },
  });
  await db.jemaahDocument.createMany({
    data: [
      { jemaahId: jem.jemaah.id, type: 'VISA_UMROH', status: 'VERIFIED' },
      { jemaahId: jem.jemaah.id, type: 'VACCINE_MENINGITIS', status: 'VERIFIED' },
    ],
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getManifestCloseNudgeCandidates({ now: new Date(), windowHours: 72 });
  const matched = r.rows.find((x) => x.bookingId === booking.id);
  assert.equal(matched, undefined, 'complete jemaah → no nudge');
});

test('getManifestCloseNudgeCandidates: already nudged → skipped (idempotency)', async (t) => {
  const tag = makeTag('s141-idem');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Pre-stamp the idempotency field
  await db.booking.update({
    where: { id: booking.id },
    data: { manifestCloseNotifiedAt: new Date() },
  });

  const r = await getManifestCloseNudgeCandidates({ now: new Date(), windowHours: 72 });
  const matched = r.rows.find((x) => x.bookingId === booking.id);
  assert.equal(matched, undefined, 'already-stamped booking excluded');
});

test('notifyManifestCloseNudge: fires EMAIL+WA + stamps idempotency field', async (t) => {
  const tag = makeTag('s141-fire');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(() => db.notification.deleteMany({
    where: { relatedEntity: 'Booking', relatedEntityId: booking.id },
  }));

  const candidates = await getManifestCloseNudgeCandidates({ now: new Date(), windowHours: 72 });
  const myCandidate = candidates.rows.find((c) => c.bookingId === booking.id);
  assert.ok(myCandidate);
  // Run notify with just this candidate so dev-DB noise doesn't slow us
  const r = await notifyManifestCloseNudge({
    candidates: { rows: [myCandidate], windowHours: 72, counts: { total: 1, overdue: 0 } },
  });
  assert.ok(r.enqueued >= 1);

  // Idempotency stamp on Booking
  const updated = await db.booking.findUnique({ where: { id: booking.id } });
  assert.ok(updated.manifestCloseNotifiedAt instanceof Date);

  // Notification rows landed
  const rows = await db.notification.findMany({
    where: { type: 'MANIFEST_CLOSE_NUDGE', relatedEntityId: booking.id },
  });
  assert.ok(rows.length >= 1);
  // Body lists missing items
  assert.match(rows[0].body, /Nomor paspor|Visa umroh|Vaksin/i);
});

test('notifyManifestCloseNudge: silent on empty candidate list', async () => {
  const r = await notifyManifestCloseNudge({
    candidates: { rows: [], windowHours: 72, counts: { total: 0, overdue: 0 } },
  });
  assert.equal(r.enqueued, 0);
  assert.equal(r.skipped, true);
});
