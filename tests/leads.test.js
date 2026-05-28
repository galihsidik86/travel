// Lead CRM service tests. Extracted from the route layer so we can hit
// the service directly without HTTP scaffolding.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  createLead, updateLead, convertLeadToBooking, deleteLead, loadOwnedLead,
} from '../src/services/leads.js';

async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`, whatsapp: '+62811',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: u.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}
const ctx = (u) => ({
  req: fakeReq, actor: { id: u.id, email: u.email, role: u.role },
});

describe('createLead — validation + audit', () => {
  test('writes lead with normalized money + records CREATE audit', async (t) => {
    const tag = makeTag('lead-create');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: {
        fullName: 'Test Lead', phone: '0812-3456',
        source: 'WA', status: 'WARM',
        estValueIdr: 1_500_000,
        score: 60,
      },
    });
    assert.equal(lead.fullName, 'Test Lead');
    assert.equal(lead.status, 'WARM');
    assert.equal(Number(lead.estValueIdr), 1_500_000, 'Decimal stored numerically');
    assert.equal(lead.score, 60);
    assert.equal(lead.agentId, agent.agent.id);

    const audited = await db.auditLog.count({
      where: { entity: 'Lead', entityId: lead.id, action: 'CREATE', actorEmail: agent.email },
    });
    assert.equal(audited, 1);
    t.after(() => db.auditLog.deleteMany({ where: { entity: 'Lead', entityId: lead.id } }));
  });

  test('fullName too short rejected by Zod', async (t) => {
    const tag = makeTag('lead-fn');
    const agent = await tempAgent(t, tag);
    await assert.rejects(
      createLead({
        ...ctx(agent), agentId: agent.agent.id,
        input: { fullName: 'A', phone: '08123456' },
      }),
      // Zod throws ZodError which doesn't have an HttpError code
      (err) => err.name === 'ZodError' || /fullName/.test(err.message),
    );
  });

  test('defaults: source=OTHER, status=COLD when omitted', async (t) => {
    const tag = makeTag('lead-def');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Default Lead', phone: '08123456' },
    });
    assert.equal(lead.source, 'OTHER');
    assert.equal(lead.status, 'COLD');
  });
});

describe('loadOwnedLead — ownership guard', () => {
  test('404 LEAD_NOT_FOUND for missing or soft-deleted', async (t) => {
    const tag = makeTag('lead-404');
    const agent = await tempAgent(t, tag);

    await assert.rejects(
      loadOwnedLead('does-not-exist', agent.agent.id),
      (err) => err.code === 'LEAD_NOT_FOUND',
    );

    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Soft-deleted', phone: '08123456' },
    });
    await db.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });

    await assert.rejects(
      loadOwnedLead(lead.id, agent.agent.id),
      (err) => err.code === 'LEAD_NOT_FOUND',
    );
  });

  test('403 FORBIDDEN when lead belongs to a different agent', async (t) => {
    const tag = makeTag('lead-403');
    const agentA = await tempAgent(t, `${tag}-a`);
    const agentB = await tempAgent(t, `${tag}-b`);
    const leadOfA = await createLead({
      ...ctx(agentA), agentId: agentA.agent.id,
      input: { fullName: 'A-owned', phone: '08123456' },
    });
    await assert.rejects(
      loadOwnedLead(leadOfA.id, agentB.agent.id),
      (err) => err.status === 403 && err.code === 'FORBIDDEN',
    );
  });
});

describe('updateLead — PATCH semantics', () => {
  test('only writes fields present in input; others preserved', async (t) => {
    const tag = makeTag('lead-patch');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Original', phone: '08111222', email: 'a@b.test', notes: 'first', source: 'WA' },
    });

    // Patch just the status
    const after = await updateLead({
      ...ctx(agent), agentId: agent.agent.id, leadId: lead.id,
      input: { status: 'WARM' },
    });
    assert.equal(after.status, 'WARM');
    // Other fields preserved
    assert.equal(after.fullName, 'Original');
    assert.equal(after.phone, '08111222');
    assert.equal(after.email, 'a@b.test');
    assert.equal(after.notes, 'first');
    assert.equal(after.source, 'WA');
  });

  test('empty string is "no change" (2-state preprocessor); explicit value writes', async (t) => {
    // The lead optStr preprocessor maps '' → undefined → field NOT in patch.
    // So sending notes: '' preserves the existing value. To overwrite, send
    // an explicit non-empty string. To CLEAR a nullable field via this
    // schema, no path is exposed today (would need a 3-state preprocessor
    // like notifPref or komisiOverridePct — documented elsewhere).
    const tag = makeTag('lead-clear');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Clearable', phone: '08111222', email: 'a@b.test', notes: 'something' },
    });
    const noChange = await updateLead({
      ...ctx(agent), agentId: agent.agent.id, leadId: lead.id,
      input: { notes: '' },
    });
    assert.equal(noChange.notes, 'something', "empty string → no change (NOT clear)");

    const overwritten = await updateLead({
      ...ctx(agent), agentId: agent.agent.id, leadId: lead.id,
      input: { notes: 'updated' },
    });
    assert.equal(overwritten.notes, 'updated');
  });

  test('cannot update lead owned by another agent', async (t) => {
    const tag = makeTag('lead-patch-403');
    const agentA = await tempAgent(t, `${tag}-a`);
    const agentB = await tempAgent(t, `${tag}-b`);
    const lead = await createLead({
      ...ctx(agentA), agentId: agentA.agent.id,
      input: { fullName: 'XX', phone: '08111222' },
    });
    await assert.rejects(
      updateLead({
        ...ctx(agentB), agentId: agentB.agent.id, leadId: lead.id,
        input: { fullName: 'Hijacked' },
      }),
      (err) => err.status === 403,
    );
  });
});

describe('convertLeadToBooking — state machine', () => {
  test('happy path: lead → CONVERTED + convertedBookingId; booking linked back', async (t) => {
    const tag = makeTag('lead-convert');
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Convertible', phone: '08111222', status: 'WARM' },
    });

    const { lead: updated, booking, paket: bookingPaket, jemaah } = await convertLeadToBooking({
      ...ctx(agent), agent: agent.agent, leadId: lead.id,
      input: { paketSlug: paket.slug, kelas: 'QUAD', paxCount: 1 },
    });

    assert.equal(updated.status, 'CONVERTED');
    assert.ok(updated.convertedAt);
    assert.equal(updated.convertedBookingId, booking.id);
    // Agent attribution: booking.agentId is THIS agent (not derived from
    // lead.interestedPaketSlug which is informational)
    assert.equal(booking.agentId, agent.agent.id);
    assert.equal(bookingPaket.slug, paket.slug);
    assert.ok(jemaah.id, 'jemaah row spawned');
  });

  test('LEAD_ALREADY_CONVERTED when convertedAt is already set', async (t) => {
    const tag = makeTag('lead-already');
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Once', phone: '08111222', status: 'WARM' },
    });
    await convertLeadToBooking({
      ...ctx(agent), agent: agent.agent, leadId: lead.id,
      input: { paketSlug: paket.slug, kelas: 'QUAD', paxCount: 1 },
    });
    // Second convert → 409
    await assert.rejects(
      convertLeadToBooking({
        ...ctx(agent), agent: agent.agent, leadId: lead.id,
        input: { paketSlug: paket.slug, kelas: 'QUAD', paxCount: 1 },
      }),
      (err) => err.status === 409 && err.code === 'LEAD_ALREADY_CONVERTED',
    );
  });

  test('LEAD_LOST when status=LOST (terminal-failed leads cannot be revived)', async (t) => {
    const tag = makeTag('lead-lost');
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Lost', phone: '08111222' },
    });
    await updateLead({
      ...ctx(agent), agentId: agent.agent.id, leadId: lead.id,
      input: { status: 'LOST' },
    });
    await assert.rejects(
      convertLeadToBooking({
        ...ctx(agent), agent: agent.agent, leadId: lead.id,
        input: { paketSlug: paket.slug, kelas: 'QUAD', paxCount: 1 },
      }),
      (err) => err.code === 'LEAD_LOST',
    );
  });

  test('createBooking errors propagate (PAKET_NOT_FOUND, KURSI_INSUFFICIENT etc.)', async (t) => {
    const tag = makeTag('lead-propagate');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Test', phone: '08111222' },
    });
    await assert.rejects(
      convertLeadToBooking({
        ...ctx(agent), agent: agent.agent, leadId: lead.id,
        input: { paketSlug: 'this-paket-does-not-exist', kelas: 'QUAD', paxCount: 1 },
      }),
      (err) => err.code === 'PAKET_NOT_FOUND',
    );
    // Lead remains in original state (not partially-converted)
    const after = await db.lead.findUnique({ where: { id: lead.id } });
    assert.equal(after.status, 'COLD');
    assert.equal(after.convertedAt, null);
  });
});

describe('deleteLead — soft delete', () => {
  test('sets deletedAt; row is gone from loadOwnedLead afterward', async (t) => {
    const tag = makeTag('lead-soft');
    const agent = await tempAgent(t, tag);
    const lead = await createLead({
      ...ctx(agent), agentId: agent.agent.id,
      input: { fullName: 'Temp', phone: '08111222' },
    });
    await deleteLead({
      ...ctx(agent), agentId: agent.agent.id, leadId: lead.id,
    });
    const raw = await db.lead.findUnique({ where: { id: lead.id } });
    assert.ok(raw.deletedAt, 'row stays in DB for audit');
    // loadOwnedLead now reports 404
    await assert.rejects(
      loadOwnedLead(lead.id, agent.agent.id),
      (err) => err.code === 'LEAD_NOT_FOUND',
    );
  });
});
