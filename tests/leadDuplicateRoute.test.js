// Stage 169 — POST /api/leads returns 409 DUPLICATE_LEAD when phone
// matches existing active lead/booking. Confirmed-resubmit bypasses.
// Tests the route via a full Express stack with proper CSRF handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempBooking } from './_helpers.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/auth.js';
import { signToken } from '../src/lib/jwt.js';

const app = createApp();

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

function tokenFor(u) {
  return signToken({ sub: u.id, email: u.email, role: u.role });
}

async function httpReq({ port, path, method = 'GET', headers = {}, body }) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path, method, headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try { return await fn(port); }
  finally { server.close(); }
}

async function postLeadWithCsrf({ port, token, body }) {
  // GET to mint CSRF cookie
  const probe = await httpReq({
    port, path: '/agen', method: 'GET',
    headers: { Cookie: `rp_session=${token}` },
  });
  const setCookie = probe.headers['set-cookie'] || [];
  const csrfMatch = (setCookie.join(';')).match(/rp_csrf=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  return httpReq({
    port, path: '/api/leads', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `rp_session=${token}; rp_csrf=${csrfToken}`,
      'X-CSRF-Token': csrfToken,
    },
    body,
  });
}

test('POST /api/leads: clean phone → 201 created', async (t) => {
  const tag = makeTag('s169-clean');
  const u = await tempAgent(t, tag);
  const token = tokenFor(u);
  await withServer(async (port) => {
    const r = await postLeadWithCsrf({ port, token, body: {
      fullName: 'Test Jemaah', phone: '081299887766', source: 'WA',
    } });
    assert.equal(r.status, 201);
    assert.ok(r.body?.lead?.id);
  });
});

test('POST /api/leads: dup lead phone → 409 DUPLICATE_LEAD with duplicates', async (t) => {
  const tag = makeTag('s169-dup-lead');
  const u = await tempAgent(t, tag);
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'Existing', phone: '081333444555', status: 'WARM', source: 'WA' },
  });
  const token = tokenFor(u);
  await withServer(async (port) => {
    const r = await postLeadWithCsrf({ port, token, body: {
      fullName: 'New', phone: '081333444555', source: 'IG',
    } });
    assert.equal(r.status, 409);
    assert.equal(r.body?.error?.code, 'DUPLICATE_LEAD');
    assert.ok(r.body?.duplicates?.leads?.length >= 1);
  });
});

test('POST /api/leads: confirmDuplicate=true bypasses warning', async (t) => {
  const tag = makeTag('s169-bypass');
  const u = await tempAgent(t, tag);
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'X', phone: '081555666777', status: 'COLD', source: 'WA' },
  });
  const token = tokenFor(u);
  await withServer(async (port) => {
    const r = await postLeadWithCsrf({ port, token, body: {
      fullName: 'New Lead', phone: '081555666777', source: 'WA',
      confirmDuplicate: true,
    } });
    assert.equal(r.status, 201, 'confirmed flag bypasses the check');
  });
});

test('POST /api/leads: dup booking phone → 409 includes booking dupes', async (t) => {
  const tag = makeTag('s169-dup-book');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: 'Existing booking jemaah', phone: '081222111000' },
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const token = tokenFor(u);
  await withServer(async (port) => {
    const r = await postLeadWithCsrf({ port, token, body: {
      fullName: 'New Lead', phone: '081222111000', source: 'WA',
    } });
    assert.equal(r.status, 409);
    assert.ok(r.body?.duplicates?.bookings?.length >= 1);
    assert.equal(r.body.duplicates.bookings[0].bookingNo, booking.bookingNo);
  });
});
