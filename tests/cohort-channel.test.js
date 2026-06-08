// Stage 55 — channel breakdown on cohort retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { getJemaahCohortRetention } from '../src/services/cohortRetention.js';

const ONE_DAY_MS = 86_400_000;

async function makeBooking(t, paket, jem, opts = {}) {
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-CH-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000',
      status: 'PENDING',
      utmSource: opts.utmSource ?? null,
      agentSlugCap: opts.agentSlugCap ?? null,
    },
  });
  if (opts.createdAt) {
    await db.booking.update({
      where: { id: b.id },
      data: { createdAt: opts.createdAt },
    });
  }
  return b;
}

test('byChannel splits cohort by utmSource (utm:fb) vs agent vs direct', async (t) => {
  const tag = makeTag('ch-split');
  const paket = await tempPaket(t, tag);
  // 6 jemaah, 2 per channel, all first-touched 400d ago, all retained
  // (second booking 300d ago). Threshold for byChannel inclusion is 5
  // jemaah/channel — only one channel will pass.
  const totals = { utm: 0, agen: 0, direct: 0 };
  for (let i = 0; i < 6; i++) {
    const jem = await tempJemaah(t, `${tag}-${i}`);
    const channel = i < 5 ? 'utm' : 'agen'; // 5 utm + 1 agen
    if (channel === 'utm') totals.utm += 1;
    else totals.agen += 1;
    const utmSource = channel === 'utm' ? 'fb' : null;
    const agentSlugCap = channel === 'agen' ? 'ahmad-w' : null;
    await makeBooking(t, paket, jem.jemaah, {
      utmSource, agentSlugCap,
      createdAt: new Date(Date.now() - 400 * ONE_DAY_MS),
    });
    // Repeat booking 300d ago → retained
    await makeBooking(t, paket, jem.jemaah, {
      utmSource, agentSlugCap,
      createdAt: new Date(Date.now() - 300 * ONE_DAY_MS),
    });
  }

  const out = await getJemaahCohortRetention({ months: 18 });
  assert.ok(Array.isArray(out.byChannel));
  // Find utm:fb row — must exist (5 jemaah, ≥ threshold) and 100% retained
  const utm = out.byChannel.find((c) => c.channel === 'utm:fb');
  assert.ok(utm, 'utm:fb channel must appear (≥5 jemaah)');
  assert.ok(utm.total >= 5);
  assert.ok(utm.retentionPct === 100 || utm.retentionPct >= 90,
    `utm:fb retention was ${utm.retentionPct}`);
  // All surfaced channels must respect the min-5-jemaah threshold
  for (const c of out.byChannel) {
    assert.ok(c.total >= 5, `channel ${c.channel} below threshold: ${c.total}`);
  }
});
