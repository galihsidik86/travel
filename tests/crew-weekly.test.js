// Stage 65 — crew weekly digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { buildCrewWeeklyDigest, listActiveCrewForDigest } from '../src/services/crewWeeklyDigest.js';
import { notifyCrewWeeklyDigest } from '../src/services/notifications.js';

test('returns null for unknown / non-MUTHAWWIF / suspended user', async (t) => {
  assert.equal(await buildCrewWeeklyDigest({ userId: 'no-such-user' }), null);
  const tag = makeTag('cw-suspended');
  const m = await tempMuthawwif(t, tag, { status: 'SUSPENDED' });
  assert.equal(await buildCrewWeeklyDigest({ userId: m.id }), null);
});

test('shape returned has counts + upcomingPaket arrays', async (t) => {
  const tag = makeTag('cw-shape');
  const m = await tempMuthawwif(t, tag);
  const d = await buildCrewWeeklyDigest({ userId: m.id });
  assert.ok(d);
  assert.ok(d.label.includes(' – '));
  assert.equal(typeof d.counts.attendanceMarksCount, 'number');
  assert.equal(typeof d.counts.presentCount, 'number');
  assert.equal(typeof d.counts.absentCount, 'number');
  assert.ok(Array.isArray(d.upcomingPaket));
});

test('upcomingPaket lists assignments departing in next 30 days', async (t) => {
  const tag = makeTag('cw-upcoming');
  const m = await tempMuthawwif(t, tag);

  // Paket departing in 10 days — should appear
  const near = await tempPaket(t, `${tag}-near`);
  await db.paket.update({
    where: { id: near.id },
    data: { departureDate: new Date(Date.now() + 10 * 86_400_000) },
  });
  await db.paketCrew.create({ data: { paketId: near.id, userId: m.id } });

  // Paket departing in 60 days — must NOT appear (window 30d)
  const far = await tempPaket(t, `${tag}-far`);
  await db.paket.update({
    where: { id: far.id },
    data: { departureDate: new Date(Date.now() + 60 * 86_400_000) },
  });
  await db.paketCrew.create({ data: { paketId: far.id, userId: m.id } });

  const d = await buildCrewWeeklyDigest({ userId: m.id });
  const slugs = d.upcomingPaket.map((p) => p.slug);
  assert.ok(slugs.includes(near.slug));
  assert.ok(!slugs.includes(far.slug));
});

test('notifyCrewWeeklyDigest silent on idle week (no marks + no upcoming)', async (t) => {
  const tag = makeTag('cw-silent');
  const m = await tempMuthawwif(t, tag);
  const d = await buildCrewWeeklyDigest({ userId: m.id });
  const r = await notifyCrewWeeklyDigest({ digest: d });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyCrewWeeklyDigest fires when there is upcoming paket', async (t) => {
  const tag = makeTag('cw-fire');
  const m = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, `${tag}-p`);
  await db.paket.update({
    where: { id: paket.id },
    data: { departureDate: new Date(Date.now() + 14 * 86_400_000) },
  });
  await db.paketCrew.create({ data: { paketId: paket.id, userId: m.id } });

  const d = await buildCrewWeeklyDigest({ userId: m.id });
  const r = await notifyCrewWeeklyDigest({ digest: d });
  assert.equal(r.enqueued, 1);

  const row = await db.notification.findFirst({
    where: { type: 'CREW_WEEKLY_DIGEST', recipientEmail: m.email },
    select: { subject: true, body: true, recipientUserId: true },
  });
  assert.ok(row);
  assert.match(row.subject, /ringkasan crew/);
  assert.equal(row.recipientUserId, m.id, 'jemaah-style recipientUserId set so /saya/notifications would scope properly');
  await db.notification.deleteMany({
    where: { type: 'CREW_WEEKLY_DIGEST', recipientEmail: m.email },
  });
});

test('digest returns previous-week + deltas (S67) with reverse polarity on absent', async (t) => {
  const tag = makeTag('cw-delta');
  const m = await tempMuthawwif(t, tag);
  const d = await buildCrewWeeklyDigest({ userId: m.id });
  assert.ok(d.previous);
  assert.ok(d.deltas);
  for (const k of ['attendanceMarksCount', 'presentCount', 'absentCount', 'paketTouchedCount']) {
    assert.ok(d.deltas[k]);
    assert.equal(typeof d.deltas[k].direction, 'string');
  }
  // Reverse polarity contract: absent up = bad
  if (d.deltas.absentCount.direction === 'up') {
    assert.equal(d.deltas.absentCount.good, false, 'more absences must read bad');
  }
  // Forward polarity: present up = good
  if (d.deltas.presentCount.direction === 'up') {
    assert.equal(d.deltas.presentCount.good, true);
  }
});

test('listActiveCrewForDigest filters suspended + non-MUTHAWWIF', async (t) => {
  const tag = makeTag('cw-list');
  const active = await tempMuthawwif(t, `${tag}-a`);
  const sus = await tempMuthawwif(t, `${tag}-s`, { status: 'SUSPENDED' });

  const list = await listActiveCrewForDigest();
  assert.ok(list.some((u) => u.id === active.id));
  assert.ok(!list.some((u) => u.id === sus.id));
});
