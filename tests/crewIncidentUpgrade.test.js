// Stage 373-375 — crew incident upgrade:
//   S373 Photo upload on incident
//   S374 Hotel/vendor contact book
//   S375 Per-jemaah quick action menu

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { db, makeTag } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';

// ── S373 — Photo upload on incident ──────────────────────────

test('S373 — Incident schema has photo columns', async () => {
  const schema = await fs.readFile('./prisma/schema.prisma', 'utf8');
  // Should be in the Incident block — check the photo fields
  assert.match(schema, /photoPath\s+String\?/);
  assert.match(schema, /photoName\s+String\?/);
  assert.match(schema, /photoSize\s+Int\?/);
  assert.match(schema, /photoMime\s+String\?/);
  assert.match(schema, /photoUploadedAt\s+DateTime\?/);
});

test('S373 — incidentStorage helper exposes move/delete + 8MB cap', async () => {
  const src = await fs.readFile('./src/lib/incidentStorage.js', 'utf8');
  assert.match(src, /MAX_INCIDENT_PHOTO_BYTES = 8 \* 1024 \* 1024/);
  assert.match(src, /ALLOWED_INCIDENT_PHOTO_MIME/);
  assert.match(src, /moveIncidentPhoto/);
  assert.match(src, /deleteIncidentPhoto/);
  assert.match(src, /private\/incidents/);
});

test('S373 — multer middleware accepts only image mimes', async () => {
  const src = await fs.readFile('./src/middleware/incidentPhotoUpload.js', 'utf8');
  assert.match(src, /uploadIncidentPhoto/);
  // Field name 'photo' distinct from docs 'file'
  assert.match(src, /upload\.single\('photo'\)/);
  // Reuses ALLOWED_INCIDENT_PHOTO_MIME allowlist
  assert.match(src, /ALLOWED_INCIDENT_PHOTO_MIME/);
});

test('S373 — createIncident persists photo metadata when file passed', async (t) => {
  const tag = makeTag('s373a');
  const crew = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash: await hashPassword('test12345'),
      role: 'MUTHAWWIF', fullName: 'Crew S373', phone: '+62811000',
    },
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { actorUserId: crew.id } });
    await db.incident.deleteMany({ where: { createdById: crew.id } });
    await db.user.deleteMany({ where: { id: crew.id } });
  });

  // Use a fake file path that's valid on disk (we'll write a tiny PNG-ish blob
  // to OS temp first so moveIncidentPhoto can rename it without throwing).
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');
  const tmpPath = path.join(os.tmpdir(), `s373-${tag}.png`);
  // Minimal 1×1 PNG bytes — enough for the mime check and file move.
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');
  await fsp.writeFile(tmpPath, tinyPng);
  t.after(async () => { try { await fsp.unlink(tmpPath); } catch { /* moved */ } });

  const { createIncident } = await import('../src/services/incidents.js');
  const incident = await createIncident({
    req: { headers: {} },
    crewUser: { id: crew.id, email: crew.email, role: 'MUTHAWWIF' },
    input: { type: 'MEDICAL', message: 'photo test', locationLabel: null },
    file: {
      path: tmpPath,
      originalname: 'photo.png',
      mimetype: 'image/png',
      size: tinyPng.length,
    },
  });
  assert.ok(incident.id);
  // The service updates the row in-place AND mutates the returned object
  assert.match(incident.photoPath || '', /private\/incidents\//);
  assert.equal(incident.photoMime, 'image/png');
  assert.ok(incident.photoSize > 0);
  // DB read confirms persistence
  const fromDb = await db.incident.findUnique({ where: { id: incident.id } });
  assert.match(fromDb.photoPath || '', /private\/incidents\//);

  // Clean up the moved file too
  if (fromDb.photoPath) {
    const { absFromRel } = await import('../src/lib/incidentStorage.js');
    try { await fsp.unlink(absFromRel(fromDb.photoPath)); } catch { /* best-effort */ }
  }
});

test('S373 — sos-fab partial is multipart with photo input', async () => {
  const src = await fs.readFile('./views/partials/sos-fab.ejs', 'utf8');
  assert.match(src, /enctype="multipart\/form-data"/);
  assert.match(src, /name="photo"/);
  assert.match(src, /capture="environment"/);
  // Offline warning when navigator.onLine === false but photo selected
  assert.match(src, /sos-photo-warn/);
  // Online path uses FormData (multipart), not URLSearchParams
  assert.match(src, /body: fd/);
});

// ── S374 — Vendor contact book ───────────────────────────────

test('S374 — schema has CrewVendorContact + VendorContactCategory enum', async () => {
  const schema = await fs.readFile('./prisma/schema.prisma', 'utf8');
  assert.match(schema, /model CrewVendorContact/);
  assert.match(schema, /enum VendorContactCategory/);
  // 8 canonical categories
  for (const cat of ['HOTEL', 'BUS', 'AMBULANCE', 'CLINIC', 'EMBASSY', 'RESTAURANT', 'GUIDE', 'OTHER']) {
    assert.ok(schema.includes(cat), `enum has ${cat}`);
  }
});

test('S374 — create/update refuses when phone AND whatsapp both empty', async (t) => {
  const tag = makeTag('s374');
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-p`, title: `Paket ${tag}`,
      departureDate: new Date('2030-01-01'), returnDate: new Date('2030-01-10'),
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 20, status: 'DRAFT',
    },
  });
  t.after(async () => {
    await db.crewVendorContact.deleteMany({ where: { paketId: paket.id } });
    await db.paket.delete({ where: { id: paket.id } });
  });

  const { createVendorContact } = await import('../src/services/crewVendorContacts.js');

  // Both contact fields missing → CONTACT_REQUIRED
  await assert.rejects(
    () => createVendorContact({
      req: { headers: {} }, actor: { email: 'test', role: 'OWNER' },
      paketId: paket.id,
      input: { category: 'HOTEL', label: 'Andalus', phone: '', whatsapp: '' },
    }),
    /Telepon atau WhatsApp/,
  );

  // Phone alone → ok
  const row = await createVendorContact({
    req: { headers: {} }, actor: { email: 'test', role: 'OWNER' },
    paketId: paket.id,
    input: { category: 'HOTEL', label: 'Andalus Front Desk', phone: '+966 14 822 6666' },
  });
  assert.equal(row.label, 'Andalus Front Desk');
  assert.equal(row.category, 'HOTEL');
});

test('S374 — crew-manifest view renders vendor contacts panel with tel + wa', async () => {
  const src = await fs.readFile('./views/crew-manifest.ejs', 'utf8');
  assert.match(src, /Kontak vendor (?:&amp;|&) darurat/);
  // Phone normalisation for wa.me deep link
  assert.match(src, /_vcDigits/);
  // tel: link is generated
  assert.match(src, /href="tel:/);
  // wa.me link
  assert.match(src, /https:\/\/wa\.me\//);
  // VC icon map covers all categories
  assert.match(src, /HOTEL: '🏨'/);
});

// ── S375 — Per-jemaah quick action menu ──────────────────────

test('S375 — manifest row has tel + wa + ICE + note quick actions', async () => {
  const src = await fs.readFile('./views/crew-manifest.ejs', 'utf8');
  // Each row's identity cell now contains a flex action strip
  // Look for the helper that strips digits + the action buttons
  assert.match(src, /_qaDigits/);
  assert.match(src, /title="Telepon /);
  assert.match(src, /title="WA /);
  // ICE only renders when ICE digits differ from primary phone (avoid duplicate icon)
  assert.match(src, /_qIceDig !== _qWaDig/);
  // Note jump button focuses the textarea after opening details
  assert.match(src, /querySelector\('textarea'\)\?\.focus\(\)/);
});
