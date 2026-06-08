// Stage 69 — jemaah self-service testimonial submit (HTTP integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { createApp } from '../src/app.js';
import { signToken, COOKIE_NAME } from '../src/lib/jwt.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

function close(srv) {
  return new Promise((r) => srv.close(r));
}

function req(srv, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = srv.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function setupLunasBooking(t, tag) {
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-LUNAS`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  return { user: jem, paket, booking: b };
}

function cookieFor(user) {
  const token = signToken({ sub: user.id, role: user.role, email: user.email });
  return `${COOKIE_NAME}=${token}`;
}

test('GET testimonial form 404s on non-owner booking', async (t) => {
  const tag = makeTag('jt-other');
  const owner = await tempJemaah(t, `${tag}-o`);
  const intruder = await tempJemaah(t, `${tag}-i`);
  const paket = await tempPaket(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id,
      jemaahId: owner.jemaah.id, jemaahUserId: owner.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', `/saya/bookings/${b.id}/testimonial`, {
      Cookie: cookieFor(intruder),
    });
    assert.equal(res.status, 404);
  } finally {
    await close(srv);
  }
});

test('GET testimonial form 400s on non-LUNAS booking', async (t) => {
  const tag = makeTag('jt-pending');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id,
      jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'PENDING',
    },
  });
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', `/saya/bookings/${b.id}/testimonial`, {
      Cookie: cookieFor(jem),
    });
    assert.equal(res.status, 400);
  } finally {
    await close(srv);
  }
});

test('LUNAS jemaah can render the form', async (t) => {
  const tag = makeTag('jt-render');
  const { user, booking } = await setupLunasBooking(t, tag);
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieFor(user),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Bagikan/i);
    assert.match(res.body, /testimoni/i);
  } finally {
    await close(srv);
  }
});

test('POST creates testimonial in DRAFT and re-submit updates same row', async (t) => {
  const tag = makeTag('jt-post');
  const { user, booking, paket } = await setupLunasBooking(t, tag);
  t.after(async () => {
    await db.testimonial.deleteMany({ where: { paketId: paket.id } });
  });
  const srv = await startServer();
  try {
    // First POST — fetch GET to get csrf cookie
    const formRes = await req(srv, 'GET', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieFor(user),
    });
    const setCookie = formRes.headers['set-cookie'] || [];
    const csrfMatch = (setCookie.join(';')).match(/rp_csrf=([^;]+)/);
    const csrfCookie = csrfMatch ? `rp_csrf=${csrfMatch[1]}` : '';
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    const cookieStr = [cookieFor(user), csrfCookie].filter(Boolean).join('; ');

    const body1 = new URLSearchParams({
      _csrf: csrfToken,
      rating: '5',
      body: 'Pelayanan sangat baik dan ramah, jemaah dibantu oleh muthawif yang sabar.',
      jemaahCity: 'Jakarta',
    }).toString();
    const post1 = await req(srv, 'POST', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieStr,
    }, body1);
    assert.equal(post1.status, 302);
    assert.match(post1.headers.location, /testimonial=submitted/);

    const created = await db.testimonial.findFirst({
      where: { paketId: paket.id },
    });
    assert.ok(created);
    assert.equal(created.status, 'DRAFT');
    assert.equal(created.rating, 5);

    // Admin flips to PUBLISHED
    await db.testimonial.update({
      where: { id: created.id },
      data: { status: 'PUBLISHED' },
    });

    // Re-submit — should reset to DRAFT
    const body2 = new URLSearchParams({
      _csrf: csrfToken,
      rating: '4',
      body: 'Versi update — masih bagus tapi hotel kurang dekat ke masjid sedikit.',
    }).toString();
    const post2 = await req(srv, 'POST', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieStr,
    }, body2);
    assert.equal(post2.status, 302);

    const updated = await db.testimonial.findFirst({
      where: { paketId: paket.id },
    });
    assert.equal(updated.id, created.id, 'same row updated, not new');
    assert.equal(updated.status, 'DRAFT', 're-submit flips back to DRAFT for re-review');
    assert.equal(updated.rating, 4);
  } finally {
    await close(srv);
  }
});

test('POST rejects body shorter than 20 chars', async (t) => {
  const tag = makeTag('jt-short');
  const { user, booking } = await setupLunasBooking(t, tag);
  const srv = await startServer();
  try {
    const formRes = await req(srv, 'GET', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieFor(user),
    });
    const setCookie = formRes.headers['set-cookie'] || [];
    const csrfMatch = (setCookie.join(';')).match(/rp_csrf=([^;]+)/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    const cookieStr = [cookieFor(user), `rp_csrf=${csrfToken}`].join('; ');

    const body = new URLSearchParams({
      _csrf: csrfToken,
      rating: '5',
      body: 'too short',
    }).toString();
    const res = await req(srv, 'POST', `/saya/bookings/${booking.id}/testimonial`, {
      Cookie: cookieStr,
    }, body);
    assert.equal(res.status, 400);
    assert.match(res.body, /minimal 20/i);
  } finally {
    await close(srv);
  }
});
