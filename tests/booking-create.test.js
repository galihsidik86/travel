// createBooking service tests — covers public anonymous, agent lock-in,
// self-booking (5t), and admin walk-in (5w) paths.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempUser, fakeReq } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { createBooking } from '../src/services/booking.js';

// Same tempAgent pattern as booking-admin.test.js.
async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const user = await db.user.create({
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
    await db.booking.updateMany({ where: { agentId: user.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

const baseInput = (paketSlug, overrides = {}) => ({
  req: fakeReq,
  paketSlug, agentSlug: null,
  fullName: 'Walk-in Test', phone: '+62812-AAAA',
  kelas: 'QUAD', paxCount: 1,
  ...overrides,
});

describe('createBooking — validation', () => {
  test('INVALID_KELAS rejects unknown kelas', async (t) => {
    const tag = makeTag('cb-kelas');
    const paket = await tempPaket(t, tag);
    await assert.rejects(
      createBooking(baseInput(paket.slug, { kelas: 'PRESIDENTIAL_SUITE' })),
      (err) => err.code === 'INVALID_KELAS',
    );
  });

  test('PAKET_NOT_FOUND for unknown slug', async (t) => {
    await assert.rejects(
      createBooking(baseInput(`nope-${makeTag('cb-no')}`)),
      (err) => err.code === 'PAKET_NOT_FOUND',
    );
  });

  test('PAKET_NOT_FOUND for non-ACTIVE paket (DRAFT, CLOSED, ARCHIVED)', async (t) => {
    const tag = makeTag('cb-draft');
    const paket = await tempPaket(t, tag);
    await db.paket.update({ where: { id: paket.id }, data: { status: 'DRAFT' } });
    await assert.rejects(
      createBooking(baseInput(paket.slug)),
      (err) => err.code === 'PAKET_NOT_FOUND',
    );
  });

  test('MANIFEST_CLOSED when manifestClosesAt has passed', async (t) => {
    const tag = makeTag('cb-closed');
    const paket = await tempPaket(t, tag);
    await db.paket.update({
      where: { id: paket.id },
      data: { manifestClosesAt: new Date(Date.now() - 86_400_000) },
    });
    await assert.rejects(
      createBooking(baseInput(paket.slug)),
      (err) => err.code === 'MANIFEST_CLOSED',
    );
  });

  test('KURSI_INSUFFICIENT when paxCount exceeds remaining seats', async (t) => {
    const tag = makeTag('cb-kursi');
    const paket = await tempPaket(t, tag);
    await db.paket.update({
      where: { id: paket.id },
      data: { kursiTotal: 5, kursiTerisi: 4 }, // only 1 seat left
    });
    await assert.rejects(
      createBooking(baseInput(paket.slug, { paxCount: 2 })),
      (err) => err.code === 'KURSI_INSUFFICIENT',
    );
  });

  test('PRICE_NOT_SET when kelas has no price tier', async (t) => {
    const tag = makeTag('cb-noprice');
    const paket = await tempPaket(t, tag); // tempPaket only seeds QUAD
    await assert.rejects(
      createBooking(baseInput(paket.slug, { kelas: 'VVIP' })),
      (err) => err.code === 'PRICE_NOT_SET',
    );
  });
});

describe('createBooking — agent lock-in invariant', () => {
  test('valid agentSlug → both agentId and agentSlugCap set', async (t) => {
    const tag = makeTag('cb-agent-ok');
    const paket = await tempPaket(t, tag);
    const agent = await tempAgent(t, tag);

    const { booking } = await createBooking(baseInput(paket.slug, {
      agentSlug: agent.agent.slug,
    }));
    assert.equal(booking.agentId, agent.agent.id, 'agentId set when slug resolves');
    assert.equal(booking.agentSlugCap, agent.agent.slug, 'agentSlugCap captured');
  });

  test('UNKNOWN agentSlug → agentId null, agentSlugCap STILL captures the URL slug', async (t) => {
    const tag = makeTag('cb-agent-bad');
    const paket = await tempPaket(t, tag);

    const { booking } = await createBooking(baseInput(paket.slug, {
      agentSlug: 'ghost-agent-does-not-exist',
    }));
    assert.equal(booking.agentId, null, 'no agent fk (slug did not resolve)');
    assert.equal(
      booking.agentSlugCap, 'ghost-agent-does-not-exist',
      'agentSlugCap captures URL slug verbatim — historical evidence even when invalid',
    );
  });

  test('agentSlug is lowercased/trimmed when captured', async (t) => {
    const tag = makeTag('cb-agent-case');
    const paket = await tempPaket(t, tag);
    const { booking } = await createBooking(baseInput(paket.slug, {
      agentSlug: '  GHOST-CAPS  ',
    }));
    assert.equal(booking.agentSlugCap, 'ghost-caps', 'lowercased + trimmed');
  });

  test('no agentSlug → both agentId and agentSlugCap null (Kantor Pusat)', async (t) => {
    const tag = makeTag('cb-agent-none');
    const paket = await tempPaket(t, tag);
    const { booking } = await createBooking(baseInput(paket.slug));
    assert.equal(booking.agentId, null);
    assert.equal(booking.agentSlugCap, null);
  });
});

describe('createBooking — bookingNo format + seat reservation', () => {
  test('bookingNo matches RP-YYYY-NNNNN', async (t) => {
    const tag = makeTag('cb-bookingno');
    const paket = await tempPaket(t, tag);
    const { booking } = await createBooking(baseInput(paket.slug));
    assert.match(booking.bookingNo, /^RP-\d{4}-\d{5}$/);
    const year = new Date().getFullYear();
    assert.ok(booking.bookingNo.startsWith(`RP-${year}-`));
  });

  test('successful booking reserves seats (kursiTerisi += paxCount)', async (t) => {
    const tag = makeTag('cb-seats');
    const paket = await tempPaket(t, tag);
    const before = await db.paket.findUnique({ where: { id: paket.id }, select: { kursiTerisi: true } });

    await createBooking(baseInput(paket.slug, { paxCount: 3 }));

    const after = await db.paket.findUnique({ where: { id: paket.id }, select: { kursiTerisi: true } });
    assert.equal(after.kursiTerisi, before.kursiTerisi + 3);
  });
});

describe('createBooking — self-booking (5t)', () => {
  test('logged-in JEMAAH: reuses canonical profile + sets jemaahUserId + selfBooked', async (t) => {
    const tag = makeTag('cb-self');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);

    const { booking, jemaah, selfBooked } = await createBooking({
      ...baseInput(paket.slug),
      loggedInUser: { id: user.id, role: 'JEMAAH', email: user.email },
    });
    assert.equal(selfBooked, true);
    assert.equal(booking.jemaahUserId, user.id, 'booking auto-linked');
    assert.equal(jemaah.id, user.jemaah.id, 'reuses canonical profile — no fresh spawn');

    // Booking should reference user's profile, NOT a new one
    assert.equal(booking.jemaahId, user.jemaah.id);
  });

  test('non-JEMAAH loggedInUser → behaves like anonymous (no auto-link)', async (t) => {
    const tag = makeTag('cb-self-wrong-role');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const paket = await tempPaket(t, tag);

    const { booking, selfBooked } = await createBooking({
      ...baseInput(paket.slug),
      loggedInUser: { id: owner.id, role: 'OWNER', email: owner.email },
    });
    assert.equal(selfBooked, false, 'OWNER booking is not a jemaah self-booking');
    assert.equal(booking.jemaahUserId, null, 'no auto-link for non-JEMAAH');
  });
});

describe('createBooking — admin walk-in (5w)', () => {
  test('adminCreator forces loggedInUser=null (selfBooked false, no jemaahUserId)', async (t) => {
    const tag = makeTag('cb-walkin');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const jemaahWhoHappensToBeLogged = await tempJemaah(t, `${tag}-j`);
    const paket = await tempPaket(t, tag);

    const { booking, selfBooked } = await createBooking({
      ...baseInput(paket.slug, { fullName: 'Walk-in Customer', phone: '+62812-XYZ' }),
      // Even with a JEMAAH "logged in" session present in the args, the
      // adminCreator path MUST override and book for the walk-in third party.
      loggedInUser: { id: jemaahWhoHappensToBeLogged.id, role: 'JEMAAH', email: jemaahWhoHappensToBeLogged.email },
      adminCreator: { id: owner.id, email: owner.email, role: 'OWNER' },
    });
    assert.equal(selfBooked, false, 'admin walk-in is NEVER a jemaah self-booking');
    assert.equal(booking.jemaahUserId, null,
      'jemaahUserId stays null — jemaah can later register + claim');
    // A fresh JemaahProfile spawned for the walk-in (not the logged-in user's)
    assert.notEqual(booking.jemaahId, jemaahWhoHappensToBeLogged.jemaah.id,
      'walk-in spawns a fresh profile');
  });

  test('admin walk-in still works with valid agentSlug (agent + adminCreator coexist)', async (t) => {
    const tag = makeTag('cb-walkin-agent');
    const owner = await tempUser(t, tag, { role: 'OWNER' });
    const paket = await tempPaket(t, tag);
    const agent = await tempAgent(t, tag);

    const { booking } = await createBooking({
      ...baseInput(paket.slug, { agentSlug: agent.agent.slug }),
      adminCreator: { id: owner.id, email: owner.email, role: 'OWNER' },
    });
    assert.equal(booking.agentId, agent.agent.id, 'agent still attributed via slug');
    assert.equal(booking.agentSlugCap, agent.agent.slug);
  });
});
