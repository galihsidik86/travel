// Document thumbnail generation + lifecycle.
//
// Tests work on real files (sharp can't reasonably be mocked + the resize
// pipeline is the point). Source JPEG is built in-process via sharp so we
// don't depend on a fixture file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { db, makeTag, tempJemaah } from './_helpers.js';
import {
  generateThumbnail, deleteThumbnail, thumbExists, thumbAbsPath, thumbRelPath,
} from '../src/lib/docThumbnail.js';
import { absFromRel, docsRoot } from '../src/lib/docStorage.js';

async function makeSourceJpeg(jemaahId, docId, { width = 800, height = 600 } = {}) {
  // Synthetic gold-on-onyx square so the resize has real pixels to compress.
  const relDir = path.posix.join('private', 'docs', jemaahId);
  const relPath = path.posix.join(relDir, `${docId}__test.jpg`);
  const abs = absFromRel(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await sharp({
    create: { width, height, channels: 3, background: { r: 212, g: 175, b: 55 } },
  }).jpeg({ quality: 90 }).toFile(abs);
  return relPath;
}

describe('generateThumbnail', () => {
  test('jpeg source → cached thumb ≤ 256 px, considerably smaller than source', async (t) => {
    const tag = makeTag('thumb-jpg');
    const user = await tempJemaah(t, tag);
    const docId = `td-${tag}`;
    const srcRel = await makeSourceJpeg(user.jemaah.id, docId, { width: 800, height: 600 });
    t.after(async () => {
      await fs.unlink(absFromRel(srcRel)).catch(() => {});
      await deleteThumbnail({ jemaahId: user.jemaah.id, docId });
    });

    const srcSize = (await fs.stat(absFromRel(srcRel))).size;
    const result = await generateThumbnail({
      jemaahId: user.jemaah.id, docId, srcRel, mime: 'image/jpeg',
    });
    assert.equal(result.ok, true);

    const thumbAbs = thumbAbsPath({ jemaahId: user.jemaah.id, docId });
    const thumbMeta = await sharp(thumbAbs).metadata();
    assert.ok(thumbMeta.width <= 256 && thumbMeta.height <= 256,
      `thumb dims (${thumbMeta.width}x${thumbMeta.height}) should be ≤ 256`);
    // Aspect ratio preserved (800x600 → 256x192)
    assert.equal(thumbMeta.width, 256);
    assert.equal(thumbMeta.height, 192);
    assert.ok(result.bytes < srcSize, `thumb (${result.bytes}B) should be smaller than source (${srcSize}B)`);
  });

  test('non-image mime → ok:false, no file written', async (t) => {
    const tag = makeTag('thumb-skip');
    const user = await tempJemaah(t, tag);
    const docId = `td-${tag}`;
    const r = await generateThumbnail({
      jemaahId: user.jemaah.id, docId, srcRel: 'private/docs/missing.pdf', mime: 'application/pdf',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mime-not-image');
    assert.equal(await thumbExists({ jemaahId: user.jemaah.id, docId }), false);
  });

  test('does not upscale a small source (withoutEnlargement)', async (t) => {
    const tag = makeTag('thumb-small');
    const user = await tempJemaah(t, tag);
    const docId = `td-${tag}`;
    const srcRel = await makeSourceJpeg(user.jemaah.id, docId, { width: 100, height: 80 });
    t.after(async () => {
      await fs.unlink(absFromRel(srcRel)).catch(() => {});
      await deleteThumbnail({ jemaahId: user.jemaah.id, docId });
    });

    await generateThumbnail({ jemaahId: user.jemaah.id, docId, srcRel, mime: 'image/jpeg' });
    const meta = await sharp(thumbAbsPath({ jemaahId: user.jemaah.id, docId })).metadata();
    assert.equal(meta.width, 100, 'tiny source preserved at original width');
    assert.equal(meta.height, 80);
  });
});

describe('deleteThumbnail + thumbExists', () => {
  test('exists after generate, gone after delete; delete-missing is no-op', async (t) => {
    const tag = makeTag('thumb-del');
    const user = await tempJemaah(t, tag);
    const docId = `td-${tag}`;
    const srcRel = await makeSourceJpeg(user.jemaah.id, docId);
    t.after(async () => {
      await fs.unlink(absFromRel(srcRel)).catch(() => {});
      await deleteThumbnail({ jemaahId: user.jemaah.id, docId });
    });

    await generateThumbnail({ jemaahId: user.jemaah.id, docId, srcRel, mime: 'image/jpeg' });
    assert.equal(await thumbExists({ jemaahId: user.jemaah.id, docId }), true);

    await deleteThumbnail({ jemaahId: user.jemaah.id, docId });
    assert.equal(await thumbExists({ jemaahId: user.jemaah.id, docId }), false);

    // Idempotent: second delete must not throw.
    await deleteThumbnail({ jemaahId: user.jemaah.id, docId });
  });
});

describe('thumbRelPath shape', () => {
  test('lives under private/docs/<jemaahId>/thumbs/<docId>.jpg', () => {
    const p = thumbRelPath({ jemaahId: 'JID', docId: 'DID' });
    assert.equal(p, 'private/docs/JID/thumbs/DID.jpg');
  });
});
