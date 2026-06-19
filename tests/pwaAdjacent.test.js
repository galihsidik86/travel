// Stage 358-360 — PWA-adjacent tests:
//   S358 geolocation attached to SOS payload + surfaced to admin
//   S359 quick-upload by doc type creates row + attaches file
//   S360 install funnel event ingestion + aggregation

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { db, makeTag, tempJemaah } from './_helpers.js';

// ── S358 ───────────────────────────────────────────────────────

test('S358 — submitJemaahHelpRequest stores normalised location in payload + audit', async (t) => {
  const tag = makeTag('s358a');
  const jem = await tempJemaah(t, tag);
  // Create an in-trip paket + LUNAS booking so the SOS gate passes.
  const dep = new Date(); dep.setDate(dep.getDate() - 1); dep.setHours(0, 0, 0, 0);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-p`, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret, durationDays: 10,
      inclusions: [], exclusions: [], kursiTotal: 20, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '5000000' }] },
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'JemaahHelpRequest', entityId: booking.id } });
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const { submitJemaahHelpRequest, getBookingHelpRequestState } = await import('../src/services/jemaahHelpRequest.js');
  const result = await submitJemaahHelpRequest({
    req: { headers: {} },
    actor: { id: jem.id, email: jem.email, role: 'JEMAAH' },
    userId: jem.id,
    message: 'Help me find the group',
    location: { latitude: 21.4225, longitude: 39.8262, accuracy: 12.5 }, // Masjid al-Haram
  });
  assert.equal(result.enqueued > 0, true);
  assert.deepEqual(result.location, {
    latitude: 21.4225, longitude: 39.8262, accuracyMeters: 13,
  });
  // State reader returns the location so admin UI can render the Maps link
  const state = await getBookingHelpRequestState({ bookingId: booking.id });
  assert.equal(state.pending, true);
  assert.ok(state.location);
  assert.equal(state.location.latitude, 21.4225);
  assert.equal(state.location.longitude, 39.8262);
});

test('S358 — invalid location coords drop silently (SOS still fires)', async (t) => {
  const tag = makeTag('s358b');
  const jem = await tempJemaah(t, tag);
  const dep = new Date(); dep.setDate(dep.getDate() - 1); dep.setHours(0, 0, 0, 0);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-p`, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret, durationDays: 10,
      inclusions: [], exclusions: [], kursiTotal: 20, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '5000000' }] },
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'JemaahHelpRequest', entityId: booking.id } });
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const { submitJemaahHelpRequest } = await import('../src/services/jemaahHelpRequest.js');
  const result = await submitJemaahHelpRequest({
    req: { headers: {} },
    actor: { id: jem.id, email: jem.email, role: 'JEMAAH' },
    userId: jem.id,
    message: 'No GPS available',
    location: { latitude: 999, longitude: 999, accuracy: 'bad' }, // garbage
  });
  assert.equal(result.enqueued > 0, true);
  assert.equal(result.location, null, 'invalid location dropped to null');
});

// ── S359 ───────────────────────────────────────────────────────

test('S359 — quick-upload endpoint definition + route wiring file-shape', async () => {
  const svc = await fs.readFile('./src/services/jemaahDocFiles.js', 'utf8');
  assert.match(svc, /quickUploadMyDocByType/);
  assert.match(svc, /QUICK_UPLOAD_TYPES/);
  assert.match(svc, /jemaahDocument\.upsert/);

  const route = await fs.readFile('./src/routes/jemaahPortal.js', 'utf8');
  assert.match(route, /\/api\/saya\/documents\/quick-upload\/:type/);
  assert.match(route, /quickUploadMyDocByType/);

  const view = await fs.readFile('./views/jemaah-booking.ejs', 'utf8');
  // Readiness card now uses per-row 📸 upload button
  assert.match(view, /rp-quick-upload-trigger/);
  assert.match(view, /data-doc-type/);
  // Native camera open on mobile via capture=environment
  assert.match(view, /capture="environment"/);
  // Upload posts via FormData to the quick-upload endpoint
  assert.match(view, /\/api\/saya\/documents\/quick-upload\//);
});

test('S359 — BAD_DOC_TYPE rejected, valid types accepted', async () => {
  const { quickUploadMyDocByType } = await import('../src/services/jemaahDocFiles.js');
  // We can't trivially invoke the file path without a real upload, but
  // exercising the type-allowlist guard with a fake file is enough.
  await assert.rejects(
    () => quickUploadMyDocByType({ userId: 'x', type: 'NUCLEAR_LAUNCH_CODES', file: { mimetype: 'image/jpeg', size: 1 } }),
    /tidak valid/,
  );
  // Valid type but missing file path fails on the upload step (after
  // type allowlist passes) — proves the allowlist gate is the first guard.
  await assert.rejects(
    () => quickUploadMyDocByType({ userId: 'x', type: 'PASSPORT', file: null }),
    /File wajib/,
  );
});

// ── S360 ───────────────────────────────────────────────────────

test('S360 — recordInstallEvent + getPwaInstallFunnel round-trip', async (t) => {
  const { recordInstallEvent, getPwaInstallFunnel, isKnownInstallEvent } = await import('../src/services/pwaInstallFunnel.js');
  assert.equal(isKnownInstallEvent('PROMPT_SHOWN'), true);
  assert.equal(isKnownInstallEvent('SOMETHING_ELSE'), false);

  // Emit one of each kind so the funnel surfaces non-zero counts. Use a
  // unique actor email so cleanup can find them without touching real rows.
  const tag = makeTag('s360');
  const actorEmail = `${tag}@telemetry.test`;
  for (const event of ['PROMPT_SHOWN', 'PROMPT_ACCEPTED', 'IOS_HINT_SHOWN', 'IOS_HINT_DISMISSED', 'INSTALLED']) {
    const r = await recordInstallEvent({
      event, userAgent: 'TestBot/1.0', kind: 'public', actorEmail,
    });
    assert.equal(r.ok, true);
  }
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PwaInstall', actorEmail } });
  });

  const funnel = await getPwaInstallFunnel({ days: 1 });
  // The global window may include other test runs, but our 5 events must
  // each be reflected (assert ≥ to handle parallel test pollution).
  assert.ok(funnel.counts.PROMPT_SHOWN >= 1);
  assert.ok(funnel.counts.PROMPT_ACCEPTED >= 1);
  assert.ok(funnel.counts.IOS_HINT_SHOWN >= 1);
  assert.ok(funnel.counts.INSTALLED >= 1);
  // Acceptance rate computed from full window — just sanity-check shape
  assert.equal(typeof funnel.acceptanceRate === 'number' || funnel.acceptanceRate === null, true);
  assert.equal(typeof funnel.iosCompletionRate === 'number' || funnel.iosCompletionRate === null, true);
});

test('S360 — unknown event names rejected without write', async () => {
  const { recordInstallEvent } = await import('../src/services/pwaInstallFunnel.js');
  const r = await recordInstallEvent({ event: 'SOMETHING_NEW', userAgent: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_event');
});

test('S360 — pwa.js wires beforeinstallprompt + appinstalled telemetry', async () => {
  const src = await fs.readFile('./shared/pwa.js', 'utf8');
  assert.match(src, /trackInstallEvent/);
  assert.match(src, /PROMPT_SHOWN/);
  assert.match(src, /PROMPT_ACCEPTED/);
  assert.match(src, /PROMPT_DISMISSED/);
  assert.match(src, /IOS_HINT_SHOWN/);
  assert.match(src, /IOS_HINT_DISMISSED/);
  assert.match(src, /INSTALLED/);
  // keepalive flag so events fired around navigation don't get cancelled
  assert.match(src, /keepalive: true/);
});

test('S360 — route mounted at /api/pwa with anonymous-friendly access', async () => {
  const app = await fs.readFile('./src/app.js', 'utf8');
  assert.match(app, /pwaInstallRouter/);
  assert.match(app, /\/api\/pwa/);
  const route = await fs.readFile('./src/routes/pwaInstall.js', 'utf8');
  assert.match(route, /optionalAuth/);
  assert.match(route, /install-event/);
});
