// Stage 326 — listMyIncidentsPaginated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempMuthawwif } from './_helpers.js';
import { listMyIncidentsPaginated } from '../src/services/incidents.js';

test('S326 — empty envelope when crew has no incidents', async (t) => {
  const tag = makeTag('s326a');
  const crew = await tempMuthawwif(t, tag);
  const r = await listMyIncidentsPaginated(crew.id);
  assert.deepEqual(r.rows, []);
  assert.equal(r.counts.total, 0);
});

test('S326 — counts respect window; rows respect status filter', async (t) => {
  const tag = makeTag('s326b');
  const crew = await tempMuthawwif(t, tag);
  // Create 2 OPEN + 1 ACKED + 1 RESOLVED in last 30 days
  for (const status of ['OPEN', 'OPEN', 'ACKED', 'RESOLVED']) {
    await db.incident.create({
      data: {
        createdById: crew.id, type: 'MEDICAL', status,
        message: `test ${status}`,
        ackedAt: status === 'ACKED' || status === 'RESOLVED' ? new Date() : null,
        resolvedAt: status === 'RESOLVED' ? new Date() : null,
        resolution: status === 'RESOLVED' ? 'done' : null,
      },
    });
  }
  // Default 'ACTIVE' → OPEN + ACKED only (3 rows)
  const active = await listMyIncidentsPaginated(crew.id);
  const mine = active.rows.filter((r) => r.createdById === crew.id);
  assert.equal(mine.length, 3);
  assert.equal(active.counts.OPEN, 2);
  assert.equal(active.counts.ACKED, 1);
  assert.equal(active.counts.RESOLVED, 1);
  assert.equal(active.counts.total, 4);

  // status='RESOLVED' → only resolved row
  const resolved = await listMyIncidentsPaginated(crew.id, { status: 'RESOLVED' });
  const mineR = resolved.rows.filter((r) => r.createdById === crew.id);
  assert.equal(mineR.length, 1);
  assert.equal(mineR[0].status, 'RESOLVED');
});
