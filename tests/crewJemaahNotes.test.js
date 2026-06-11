// Stage 187 — crew per-jemaah notes. Crew adds private notes per
// (paket, jemaah); composite unique upserts in place; empty body
// deletes the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempMuthawwif } from './_helpers.js';
import {
  saveCrewJemaahNote, getMyCrewJemaahNote, getAllCrewNotesForPaket,
  CREW_JEMAAH_NOTE_MAX_LEN,
} from '../src/services/crewJemaahNotes.js';

async function assigned(t, tag) {
  const crew = await tempMuthawwif(t, `${tag}-c`);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Assign crew to paket via PaketCrew composite PK
  await db.paketCrew.create({
    data: { paketId: paket.id, userId: crew.id },
  });
  t.after(async () => {
    await db.crewJemaahNote.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id, userId: crew.id } });
  });
  return { crew, paket, jemaah: jem.jemaah, booking };
}

test('CREW_JEMAAH_NOTE_MAX_LEN sane', () => {
  assert.equal(CREW_JEMAAH_NOTE_MAX_LEN, 2000);
});

test('saveCrewJemaahNote: creates note + readback via getMine', async (t) => {
  const tag = makeTag('s187-create');
  const { crew, paket, jemaah } = await assigned(t, tag);
  const r = await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug,
    jemaahId: jemaah.id, body: 'Lansia perlu pendamping',
  });
  assert.equal(r.deleted, false);
  assert.equal(r.row.body, 'Lansia perlu pendamping');

  const mine = await getMyCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id,
  });
  assert.equal(mine.body, 'Lansia perlu pendamping');
});

test('saveCrewJemaahNote: re-save upserts (no duplicate row)', async (t) => {
  const tag = makeTag('s187-upsert');
  const { crew, paket, jemaah } = await assigned(t, tag);
  await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'v1',
  });
  await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'v2',
  });
  const rows = await db.crewJemaahNote.findMany({
    where: { paketId: paket.id, crewUserId: crew.id, jemaahId: jemaah.id },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'v2');
});

test('saveCrewJemaahNote: empty body deletes existing note', async (t) => {
  const tag = makeTag('s187-del');
  const { crew, paket, jemaah } = await assigned(t, tag);
  await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'to be deleted',
  });
  const r = await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: '',
  });
  assert.equal(r.deleted, true);
  const mine = await getMyCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id,
  });
  assert.equal(mine, null);
});

test('saveCrewJemaahNote: unassigned crew → 404', async (t) => {
  const tag = makeTag('s187-noassign');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const otherCrew = await tempMuthawwif(t, `${tag}-other`);
  // No PaketCrew row → otherCrew is unassigned

  await assert.rejects(
    saveCrewJemaahNote({
      userId: otherCrew.id, paketSlug: paket.slug,
      jemaahId: jem.jemaah.id, body: 'sneaky',
    }),
    /NOT_ASSIGNED|tidak/i,
  );
});

test('saveCrewJemaahNote: jemaah not on paket → 404', async (t) => {
  const tag = makeTag('s187-not-on');
  const { crew, paket } = await assigned(t, tag);
  // Different jemaah, not booked on this paket
  const otherJem = await tempJemaah(t, `${tag}-other`);
  await assert.rejects(
    saveCrewJemaahNote({
      userId: crew.id, paketSlug: paket.slug,
      jemaahId: otherJem.jemaah.id, body: 'sneaky',
    }),
    /JEMAAH_NOT_ON_PAKET|ada di paket/i,
  );
});

test('saveCrewJemaahNote: body too long → NOTE_TOO_LONG', async (t) => {
  const tag = makeTag('s187-toolong');
  const { crew, paket, jemaah } = await assigned(t, tag);
  await assert.rejects(
    saveCrewJemaahNote({
      userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id,
      body: 'x'.repeat(CREW_JEMAAH_NOTE_MAX_LEN + 1),
    }),
    /NOTE_TOO_LONG|karakter/,
  );
});

test('getAllCrewNotesForPaket: returns notes grouped by jemaahId', async (t) => {
  const tag = makeTag('s187-rollup');
  const { crew, paket, jemaah } = await assigned(t, tag);
  await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'A note',
  });
  const grouped = await getAllCrewNotesForPaket({ paketId: paket.id });
  assert.ok(grouped[jemaah.id]);
  assert.equal(grouped[jemaah.id].length, 1);
  assert.equal(grouped[jemaah.id][0].body, 'A note');
  assert.ok(grouped[jemaah.id][0].authorName);
});

test('saveCrewJemaahNote: two different crew can each leave their own note', async (t) => {
  const tag = makeTag('s187-two');
  const { crew, paket, jemaah } = await assigned(t, tag);
  const crew2 = await tempMuthawwif(t, `${tag}-c2`);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew2.id } });
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { paketId: paket.id, userId: crew2.id } });
  });

  await saveCrewJemaahNote({
    userId: crew.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'from crew1',
  });
  await saveCrewJemaahNote({
    userId: crew2.id, paketSlug: paket.slug, jemaahId: jemaah.id, body: 'from crew2',
  });
  const rows = await db.crewJemaahNote.findMany({
    where: { paketId: paket.id, jemaahId: jemaah.id },
  });
  assert.equal(rows.length, 2, 'two crew → two separate rows');
});
