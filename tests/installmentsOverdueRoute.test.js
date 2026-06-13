// Stage 273 — admin overdue queue route + per-booking remind action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { signToken } from '../src/lib/jwt.js';

import { db, tempPaket, tempJemaah, tempBooking, tempUser, makeTag } from './_helpers.js';
import { createApp } from '../src/app.js';
import { setBookingInstallmentSchedule } from '../src/services/bookingInstallments.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve({
      server,
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function loginCookie(user) {
  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  return `rp_session=${token}`;
}

test('/admin/installments-overdue: 302 redirect when unauthenticated', async (t) => {
  const app = createApp();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const res = await fetch(url + '/admin/installments-overdue', { redirect: 'manual' });
  // Unauthenticated HTML page → 302 to /login (per CLAUDE.md auth contract)
  assert.equal(res.status, 302);
});

test('/admin/installments-overdue: 200 + renders empty state when no overdue', async (t) => {
  const app = createApp();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const owner = await tempUser(t, makeTag('iorl-em-ow'), { role: 'OWNER' });
  const cookie = await loginCookie(owner);
  const res = await fetch(url + '/admin/installments-overdue', { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Either empty-state OR actual rows; both are valid renders. Check the page loaded.
  assert.ok(html.includes('Cicilan overdue'));
});

test('/admin/installments-overdue: surfaces overdue booking in the table', async (t) => {
  const app = createApp();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const paket = await tempPaket(t, 'iorl-row');
  const jemaah = await tempJemaah(t, 'iorl-row');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [{ dueDate: '2026-01-01', amountIdr: 5000000 }],
  });
  const owner = await tempUser(t, makeTag('iorl-row-ow'), { role: 'OWNER' });
  const cookie = await loginCookie(owner);
  const res = await fetch(url + '/admin/installments-overdue', { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(b.bookingNo), 'bookingNo present in page');
  assert.ok(html.includes('Kirim reminder'), 'remind button rendered');
});

test('POST /admin/installments-overdue/:id/remind: enqueues notif + redirects', async (t) => {
  const app = createApp();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const paket = await tempPaket(t, 'iorl-rm');
  const jemaah = await tempJemaah(t, 'iorl-rm');
  // Set departure 30 days out so the reminder context makes sense
  const departure = new Date(); departure.setDate(departure.getDate() + 30);
  await db.paket.update({ where: { id: paket.id }, data: { departureDate: departure, returnDate: departure } });
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [{ dueDate: '2026-01-01', amountIdr: 5000000 }],
  });
  const owner = await tempUser(t, makeTag('iorl-rm-ow'), { role: 'OWNER' });
  const cookie = await loginCookie(owner);
  // First GET to mint CSRF cookie
  const r1 = await fetch(url + '/admin/installments-overdue', { headers: { cookie } });
  const cookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
  const csrf = (cookies.find((c) => c.startsWith('rp_csrf=')) || '').split('=')[1]?.split(';')[0];
  assert.ok(csrf, 'csrf cookie minted');
  const before = await db.notification.count({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'PAYMENT_REMINDER' },
  });
  const res = await fetch(url + '/admin/installments-overdue/' + b.id + '/remind', {
    method: 'POST',
    headers: {
      cookie: `${cookie}; rp_csrf=${csrf}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `_csrf=${csrf}`,
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  const after = await db.notification.count({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'PAYMENT_REMINDER' },
  });
  assert.ok(after > before, 'reminder enqueued');
});
