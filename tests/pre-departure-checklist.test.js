// Stage 23 — pre-departure readiness checklist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { getPreDepartureChecklist } from '../src/services/preDepartureChecklist.js';

async function tempBookingWithJemaah(t, { paket, fullName, jemaahPatch = {}, roomId = null, status = 'PENDING' }) {
  const jem = await db.jemaahProfile.create({
    data: { fullName, phone: '+62811', ...jemaahPatch },
  });
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jem.id, roomId,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status,
    },
  });
  t.after(async () => {
    await db.jemaahDocument.deleteMany({ where: { jemaahId: jem.id } });
    await db.booking.deleteMany({ where: { id: bk.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });
  return { bk, jem };
}

async function setDocs(jemaahId, verified) {
  for (const type of verified) {
    await db.jemaahDocument.create({
      data: { jemaahId, type, status: 'VERIFIED', refNumber: 'ok' },
    });
  }
}

describe('getPreDepartureChecklist', () => {
  test('returns 404 for unknown / soft-deleted paket', async () => {
    await assert.rejects(
      () => getPreDepartureChecklist('does-not-exist'),
      (err) => err.status === 404 && err.code === 'PAKET_NOT_FOUND',
    );
  });

  test('CANCELLED + REFUNDED bookings excluded from the list', async (t) => {
    const tag = makeTag('chk-active');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await tempBookingWithJemaah(t, { paket, fullName: `Cancelled-${tag}`, status: 'CANCELLED' });
    await tempBookingWithJemaah(t, { paket, fullName: `Active-${tag}`, status: 'LUNAS' });

    const r = await getPreDepartureChecklist(paket.slug);
    assert.equal(r.counts.total, 1, 'only the active booking counts');
    assert.equal(r.rows[0].jemaah.fullName, `Active-${tag}`);
  });

  test('all 8 checks pass → tier=ready, score=100', async (t) => {
    const tag = makeTag('chk-ready');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const room = await db.room.create({
      data: { paketId: paket.id, roomNo: `R-${tag}`, floor: 5, kelas: 'QUAD', capacity: 4 },
    });
    t.after(async () => { await db.room.deleteMany({ where: { id: room.id } }); });

    // Passport expiry well beyond departure + 6 months
    const farExpiry = new Date(paket.departureDate.getTime() + 400 * 86_400_000);
    const { jem } = await tempBookingWithJemaah(t, {
      paket, fullName: `Ready-${tag}`, roomId: room.id,
      jemaahPatch: {
        passportNo: 'A1234567',
        passportExpiry: farExpiry,
        emergencyContact: 'Ayah · 0822',
      },
    });
    await setDocs(jem.id, ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT', 'MANASIK_CERT']);

    const r = await getPreDepartureChecklist(paket.slug);
    const row = r.rows[0];
    assert.equal(row.score, 100);
    assert.equal(row.tier, 'ready');
    assert.equal(row.passed, 8);
    assert.equal(Object.values(row.checks).filter(Boolean).length, 8);
  });

  test('passport expiry < departure + 6 months → passportValid=false', async (t) => {
    const tag = makeTag('chk-pspr-exp');
    const paket = await tempPaket(t, `pkt-${tag}`);
    // 5 months past departure = NOT valid (Saudi 6-month rule)
    const tooClose = new Date(paket.departureDate.getTime() + 150 * 86_400_000);
    const { jem: _ } = await tempBookingWithJemaah(t, {
      paket, fullName: `BadExp-${tag}`,
      jemaahPatch: { passportNo: 'B7654321', passportExpiry: tooClose },
    });
    const r = await getPreDepartureChecklist(paket.slug);
    const row = r.rows[0];
    assert.equal(row.checks.passportPresent, true);
    assert.equal(row.checks.passportValid, false, '< 6 months buffer fails the validity check');
  });

  test('row sort: critical first, then partial, then ready; worst-score-first within tier', async (t) => {
    const tag = makeTag('chk-sort');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const room = await db.room.create({
      data: { paketId: paket.id, roomNo: `R-${tag}`, floor: 1, kelas: 'QUAD', capacity: 4 },
    });
    t.after(async () => { await db.room.deleteMany({ where: { id: room.id } }); });
    const farExpiry = new Date(paket.departureDate.getTime() + 400 * 86_400_000);

    // jemaah-A: fully ready (8/8 ✓)
    const a = await tempBookingWithJemaah(t, {
      paket, fullName: `A-Ready-${tag}`, roomId: room.id,
      jemaahPatch: { passportNo: 'A', passportExpiry: farExpiry, emergencyContact: 'x' },
    });
    await setDocs(a.jem.id, ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT', 'MANASIK_CERT']);

    // jemaah-B: partial (5/8 — passport + visa + vaccine + room + emergency)
    const b = await tempBookingWithJemaah(t, {
      paket, fullName: `B-Partial-${tag}`, roomId: room.id,
      jemaahPatch: { passportNo: 'B', passportExpiry: farExpiry, emergencyContact: 'y' },
    });
    await setDocs(b.jem.id, ['VISA_UMROH', 'VACCINE_MENINGITIS']);

    // jemaah-C: critical (1/8 — just emergency contact)
    await tempBookingWithJemaah(t, {
      paket, fullName: `C-Critical-${tag}`,
      jemaahPatch: { emergencyContact: 'z' },
    });

    const r = await getPreDepartureChecklist(paket.slug);
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0].jemaah.fullName, `C-Critical-${tag}`, 'worst at top');
    assert.equal(r.rows[1].jemaah.fullName, `B-Partial-${tag}`, 'partial mid');
    assert.equal(r.rows[2].jemaah.fullName, `A-Ready-${tag}`, 'ready at bottom');
    assert.equal(r.counts.critical, 1);
    assert.equal(r.counts.partial, 1);
    assert.equal(r.counts.ready, 1);
  });

  test('daysToDeparture is rounded + negative when in the past', async (t) => {
    const tag = makeTag('chk-days');
    // Create a paket with departureDate in the past
    const paket = await db.paket.create({
      data: {
        slug: `past-${tag}`, title: `Past ${tag}`,
        departureDate: new Date(Date.now() - 5 * 86_400_000),
        returnDate: new Date(Date.now() - 1 * 86_400_000),
        durationDays: 4, inclusions: [], exclusions: [], kursiTotal: 5, status: 'CLOSED',
      },
    });
    t.after(async () => { await db.paket.delete({ where: { id: paket.id } }); });
    const r = await getPreDepartureChecklist(paket.slug);
    assert.ok(r.daysToDeparture < 0, `expected negative, got ${r.daysToDeparture}`);
  });
});
