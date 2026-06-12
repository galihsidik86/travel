// Stage 232-234 — booking tag autopilot (LANSIA / PERTAMA / KELUARGA).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  computeAutoTagsPure,
  computeAutoTagsForBooking,
  autoTagBooking,
  retroTagKeluargaCohort,
  runAutoTagBackfill,
  KELUARGA_THRESHOLD,
  LANSIA_AGE,
} from '../src/services/bookingAutoTag.js';

const sysActor = { id: null, email: 'system', role: null };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

// ── computeAutoTagsPure (no DB) ──────────────────────────────

test('computeAutoTagsPure: LANSIA when age ≥ 60 at departure', () => {
  const departure = new Date('2027-01-01');
  const birth = new Date('1960-01-01'); // 67 at departure
  const r = computeAutoTagsPure({
    jemaah: { birthDate: birth, emergencyContact: null },
    paket: { departureDate: departure },
    priorLunasCount: 5,
    sharedEcContactBookingCount: 0,
  });
  assert.ok(r.includes('LANSIA'));
});

test('computeAutoTagsPure: no LANSIA when age < 60', () => {
  const departure = new Date('2027-01-01');
  const birth = new Date('1980-01-01'); // 47 at departure
  const r = computeAutoTagsPure({
    jemaah: { birthDate: birth, emergencyContact: null },
    paket: { departureDate: departure },
    priorLunasCount: 5,
    sharedEcContactBookingCount: 0,
  });
  assert.ok(!r.includes('LANSIA'));
});

test('computeAutoTagsPure: LANSIA edge — exactly 60 at departure', () => {
  const departure = new Date('2027-06-15');
  const birth = new Date('1967-06-15'); // exactly 60 on the day
  const r = computeAutoTagsPure({
    jemaah: { birthDate: birth, emergencyContact: null },
    paket: { departureDate: departure },
    priorLunasCount: 0, sharedEcContactBookingCount: 0,
  });
  assert.ok(r.includes('LANSIA'));
});

test('computeAutoTagsPure: birthday not yet passed at departure → still 59, no LANSIA', () => {
  const departure = new Date('2027-06-15');
  // birthday is 2027-06-16 → on 06-15 they're still 59
  const birth = new Date('1967-06-16');
  const r = computeAutoTagsPure({
    jemaah: { birthDate: birth, emergencyContact: null },
    paket: { departureDate: departure },
    priorLunasCount: 0, sharedEcContactBookingCount: 0,
  });
  assert.ok(!r.includes('LANSIA'));
});

test('computeAutoTagsPure: PERTAMA when priorLunasCount=0', () => {
  const r = computeAutoTagsPure({
    jemaah: { birthDate: null, emergencyContact: null },
    paket: { departureDate: new Date() },
    priorLunasCount: 0, sharedEcContactBookingCount: 0,
  });
  assert.ok(r.includes('PERTAMA'));
});

test('computeAutoTagsPure: no PERTAMA when priorLunasCount > 0', () => {
  const r = computeAutoTagsPure({
    jemaah: { birthDate: null, emergencyContact: null },
    paket: { departureDate: new Date() },
    priorLunasCount: 1, sharedEcContactBookingCount: 0,
  });
  assert.ok(!r.includes('PERTAMA'));
});

test('computeAutoTagsPure: KELUARGA when shared EC ≥ threshold', () => {
  const r = computeAutoTagsPure({
    jemaah: { birthDate: null, emergencyContact: 'Ibu · 0812-xxx' },
    paket: { departureDate: new Date() },
    priorLunasCount: 0, sharedEcContactBookingCount: KELUARGA_THRESHOLD,
  });
  assert.ok(r.includes('KELUARGA'));
});

test('computeAutoTagsPure: no KELUARGA without emergencyContact', () => {
  const r = computeAutoTagsPure({
    jemaah: { birthDate: null, emergencyContact: null },
    paket: { departureDate: new Date() },
    priorLunasCount: 0, sharedEcContactBookingCount: 10,
  });
  assert.ok(!r.includes('KELUARGA'));
});

// ── computeAutoTagsForBooking (DB-backed counts) ─────────────

test('computeAutoTagsForBooking: empty booking → no auto-tags', async (t) => {
  const tag = makeTag('s232-empty');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // No birthDate, no prior LUNAS, no EC
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await computeAutoTagsForBooking(b.id);
  // PERTAMA always fires for fresh jemaah (priorLunasCount=0)
  assert.deepEqual(r, ['PERTAMA']);
});

test('computeAutoTagsForBooking: LANSIA fires when jemaah birthDate makes them ≥60', async (t) => {
  const tag = makeTag('s232-lansia');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Set birthDate to make age=65 at paket departure
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { birthDate: new Date(paket.departureDate.getTime() - 65 * 365 * 86_400_000) },
  });
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await computeAutoTagsForBooking(b.id);
  assert.ok(r.includes('LANSIA'));
});

test('computeAutoTagsForBooking: PERTAMA suppressed when prior LUNAS exists', async (t) => {
  const tag = makeTag('s233-priorlunas');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Existing LUNAS booking for this jemaah on another paket
  const otherPaket = await tempPaket(t, tag + '-prior');
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-LP`, paketId: otherPaket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '500',
      status: 'LUNAS',
    },
  });
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await computeAutoTagsForBooking(b.id);
  assert.ok(!r.includes('PERTAMA'));
});

test('computeAutoTagsForBooking: KELUARGA fires when 3 bookings share EC on same paket', async (t) => {
  const tag = makeTag('s234-keluarga');
  const paket = await tempPaket(t, tag);
  const sharedEc = 'Ibu Sari · 0812-3333-4444';
  // 3 different jemaah profiles, all share the same emergencyContact
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  const j3 = await tempJemaah(t, tag + '-3');
  await db.jemaahProfile.updateMany({
    where: { id: { in: [j1.jemaah.id, j2.jemaah.id, j3.jemaah.id] } },
    data: { emergencyContact: sharedEc },
  });
  await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });

  const r = await computeAutoTagsForBooking(b3.id);
  assert.ok(r.includes('KELUARGA'));
});

test('computeAutoTagsForBooking: KELUARGA not yet at 2 bookings (below threshold)', async (t) => {
  const tag = makeTag('s234-below');
  const paket = await tempPaket(t, tag);
  const sharedEc = 'Ibu Sari · 0812-AB';
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  await db.jemaahProfile.updateMany({
    where: { id: { in: [j1.jemaah.id, j2.jemaah.id] } },
    data: { emergencyContact: sharedEc },
  });
  await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });

  const r = await computeAutoTagsForBooking(b2.id);
  assert.ok(!r.includes('KELUARGA'));
});

test('computeAutoTagsForBooking: CANCELLED bookings excluded from KELUARGA count', async (t) => {
  const tag = makeTag('s234-cancelled');
  const paket = await tempPaket(t, tag);
  const ec = 'Bpk Tag · 0812';
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  const j3 = await tempJemaah(t, tag + '-3');
  await db.jemaahProfile.updateMany({
    where: { id: { in: [j1.jemaah.id, j2.jemaah.id, j3.jemaah.id] } },
    data: { emergencyContact: ec },
  });
  // 1 ACTIVE + 1 CANCELLED + this new one
  await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-CC`, paketId: paket.id, jemaahId: j2.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });
  t.after(async () => { await db.booking.deleteMany({ where: { id: cancelled.id } }); });

  const r = await computeAutoTagsForBooking(b3.id);
  // Only 2 active (j1 + j3) — below threshold
  assert.ok(!r.includes('KELUARGA'));
});

// ── autoTagBooking (apply + persist) ─────────────────────────

test('autoTagBooking: writes new auto-tags + audit row', async (t) => {
  const tag = makeTag('s232-apply');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  assert.deepEqual(r.added, ['PERTAMA']);

  const after = await db.booking.findUnique({ where: { id: b.id }, select: { tags: true, autoTaggedSeen: true } });
  assert.deepEqual(after.tags, ['PERTAMA']);
  assert.deepEqual(after.autoTaggedSeen, ['PERTAMA']);

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' }, take: 1,
  });
  assert.equal(audits[0].after.autoTagged, true);
  assert.deepEqual(audits[0].after.autoTagsAdded, ['PERTAMA']);
});

test('autoTagBooking: additive — preserves admin manual tags', async (t) => {
  const tag = makeTag('s232-additive');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Admin pre-tags with VIP
  await db.booking.update({ where: { id: b.id }, data: { tags: ['VIP'] } });

  await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { tags: true } });
  // PERTAMA added; VIP preserved
  assert.ok(after.tags.includes('VIP'));
  assert.ok(after.tags.includes('PERTAMA'));
});

test('autoTagBooking: idempotent re-run does nothing when nothing new', async (t) => {
  const tag = makeTag('s232-idempotent');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  const auditCountBefore = await db.auditLog.count({ where: { entity: 'Booking', entityId: b.id } });

  // Re-run — should not add anything (PERTAMA already there)
  const r = await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  assert.deepEqual(r.added, []);

  const auditCountAfter = await db.auditLog.count({ where: { entity: 'Booking', entityId: b.id } });
  assert.equal(auditCountAfter, auditCountBefore);
});

test('autoTagBooking: "no re-add" — admin removed tag stays removed', async (t) => {
  const tag = makeTag('s232-noreadd');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // First pass adds PERTAMA
  await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  // Admin removes PERTAMA but leaves autoTaggedSeen as-is
  await db.booking.update({ where: { id: b.id }, data: { tags: [] } });

  // Second pass — should respect admin's removal
  const r = await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  assert.deepEqual(r.added, []);
  assert.ok(r.skipped.includes('PERTAMA'));
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { tags: true } });
  assert.deepEqual(after.tags, []);
});

test('autoTagBooking: refuses on CANCELLED (no auto-tag on frozen history)', async (t) => {
  const tag = makeTag('s232-cancelled');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: b.id } }); });

  const r = await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b.id });
  assert.deepEqual(r.added, []);
});

// ── retroTagKeluargaCohort (back-tag prior cohort members) ───

test('retroTagKeluargaCohort: tags prior bookings sharing emergencyContact', async (t) => {
  const tag = makeTag('s234-retro');
  const paket = await tempPaket(t, tag);
  const ec = 'Mama · 081234';
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  const j3 = await tempJemaah(t, tag + '-3');
  await db.jemaahProfile.updateMany({
    where: { id: { in: [j1.jemaah.id, j2.jemaah.id, j3.jemaah.id] } },
    data: { emergencyContact: ec },
  });
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });

  // Only b3 has KELUARGA added directly
  await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b3.id });

  // Now b1 + b2 should ALSO have KELUARGA via the retro pass
  const after1 = await db.booking.findUnique({ where: { id: b1.id }, select: { tags: true } });
  const after2 = await db.booking.findUnique({ where: { id: b2.id }, select: { tags: true } });
  assert.ok(after1.tags.includes('KELUARGA'));
  assert.ok(after2.tags.includes('KELUARGA'));
});

test('retroTagKeluargaCohort: respects "no re-add" on cohort members', async (t) => {
  const tag = makeTag('s234-noreadd-retro');
  const paket = await tempPaket(t, tag);
  const ec = 'Pak · 0812';
  const j1 = await tempJemaah(t, tag + '-1');
  const j2 = await tempJemaah(t, tag + '-2');
  const j3 = await tempJemaah(t, tag + '-3');
  await db.jemaahProfile.updateMany({
    where: { id: { in: [j1.jemaah.id, j2.jemaah.id, j3.jemaah.id] } },
    data: { emergencyContact: ec },
  });
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  // b1 has autoTaggedSeen including KELUARGA (admin removed it before)
  await db.booking.update({
    where: { id: b1.id },
    data: { autoTaggedSeen: ['KELUARGA'], tags: [] },
  });
  await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });

  await autoTagBooking({ req: fakeReq, actor: sysActor, bookingId: b3.id });

  const after1 = await db.booking.findUnique({ where: { id: b1.id }, select: { tags: true } });
  // b1 should NOT have KELUARGA re-added
  assert.ok(!after1.tags.includes('KELUARGA'));
});

// ── runAutoTagBackfill ───────────────────────────────────────

test('runAutoTagBackfill: scans active bookings + tags them', async (t) => {
  const tag = makeTag('s232-backfill');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await runAutoTagBackfill({});
  // At least our test booking touched
  assert.ok(r.scanned >= 1);
  assert.ok(r.touched >= 1);
});

test('LANSIA_AGE + KELUARGA_THRESHOLD constants exposed', () => {
  assert.equal(LANSIA_AGE, 60);
  assert.equal(KELUARGA_THRESHOLD, 3);
});
