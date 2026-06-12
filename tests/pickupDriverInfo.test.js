// Stage 220 — per-pickup driver contact + plate.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { PickupSchema, createPickup, updatePickup } from '../src/services/paketPickups.js';
import { buildPickupRosterCsv } from '../src/services/pickupRosterCsv.js';

const sysActor = { id: 'sys', email: 'sys@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', get: () => 'test' };

test('PickupSchema: accepts driver fields; null/empty clears', () => {
  const r = PickupSchema.parse({
    label: 'Bekasi', address: 'addr-1',
    driverName: 'Pak Ali', driverPhone: '+62811', plateNumber: 'b 1234 cde',
  });
  assert.equal(r.driverName, 'Pak Ali');
  assert.equal(r.driverPhone, '+62811');
  // Plate uppercased
  assert.equal(r.plateNumber, 'B 1234 CDE');

  const cleared = PickupSchema.parse({
    label: 'Bekasi', address: 'addr-1',
    driverName: '', driverPhone: '', plateNumber: '',
  });
  assert.equal(cleared.driverName, null);
  assert.equal(cleared.driverPhone, null);
  assert.equal(cleared.plateNumber, null);
});

test('createPickup: persists driver fields', async (t) => {
  const tag = makeTag('s220-create');
  const paket = await tempPaket(t, tag);
  const row = await createPickup({
    req: fakeReq, actor: sysActor, paketId: paket.id,
    input: {
      label: 'Bekasi', address: 'Bekasi Sq',
      driverName: 'Pak Ali', driverPhone: '+62811', plateNumber: 'B 1234 CDE',
    },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });
  assert.equal(row.driverName, 'Pak Ali');
  assert.equal(row.driverPhone, '+62811');
  assert.equal(row.plateNumber, 'B 1234 CDE');
});

test('updatePickup: clears driver fields when passed empty strings', async (t) => {
  const tag = makeTag('s220-clear');
  const paket = await tempPaket(t, tag);
  const created = await createPickup({
    req: fakeReq, actor: sysActor, paketId: paket.id,
    input: {
      label: 'Bekasi', address: 'Bekasi Sq',
      driverName: 'Pak Ali', driverPhone: '+62811', plateNumber: 'B 1',
    },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const updated = await updatePickup({
    req: fakeReq, actor: sysActor, id: created.id,
    input: {
      label: 'Bekasi', address: 'Bekasi Sq',
      driverName: '', driverPhone: '', plateNumber: '',
    },
  });
  assert.equal(updated.driverName, null);
  assert.equal(updated.driverPhone, null);
  assert.equal(updated.plateNumber, null);
});

test('buildPickupRosterCsv: includes driverName/driverPhone/plateNumber columns', async (t) => {
  const tag = makeTag('s220-csv');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await db.paketPickup.create({
    data: {
      paketId: paket.id, label: 'Bekasi', address: 'addr', sortOrder: 1,
      driverName: 'Pak Ali', driverPhone: '+6281100000000', plateNumber: 'B 1234 CDE',
    },
  });
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: pickup.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug);
  const headerLine = r.csv.replace(/^\ufeff/, '').split('\r\n')[0];
  assert.match(headerLine, /driverName/);
  assert.match(headerLine, /driverPhone/);
  assert.match(headerLine, /plateNumber/);
  assert.match(r.csv, /Pak Ali/);
  assert.match(r.csv, /B 1234 CDE/);
});

test('buildPickupRosterCsv: TBD rows show empty driver columns (no crash)', async (t) => {
  const tag = makeTag('s220-tbd');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Booking with NO pickup → should land in TBD row
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await buildPickupRosterCsv(paket.slug);
  // Should not crash + should mention TBD
  assert.match(r.csv, /TBD/);
  // No "null" literal in output (defensive against null handling)
  assert.doesNotMatch(r.csv, /,null,/);
});
