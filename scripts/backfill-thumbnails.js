// One-shot: generate missing thumbnails for existing image-mime JemaahDocument
// uploads. Safe to re-run — only generates when no cached thumb exists.
//
// Usage:   node scripts/backfill-thumbnails.js
// Options: --force    re-generate even if a cached thumb already exists
//          --dry-run  scan + report what would be generated, don't write

import { db } from '../src/lib/db.js';
import {
  generateThumbnail, thumbExists, isInlineImageMime,
} from '../src/lib/docThumbnail.js';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');

async function main() {
  const docs = await db.jemaahDocument.findMany({
    where: { filePath: { not: null } },
    select: { id: true, jemaahId: true, filePath: true, mimeType: true },
  });
  let scanned = 0, eligible = 0, generated = 0, skipped = 0, failed = 0;

  for (const doc of docs) {
    scanned += 1;
    if (!isInlineImageMime(doc.mimeType)) { skipped += 1; continue; }
    eligible += 1;
    if (!FORCE && await thumbExists({ jemaahId: doc.jemaahId, docId: doc.id })) {
      skipped += 1; continue;
    }
    if (DRY) { generated += 1; continue; }
    try {
      const r = await generateThumbnail({
        jemaahId: doc.jemaahId, docId: doc.id,
        srcRel: doc.filePath, mime: doc.mimeType,
      });
      if (r.ok) {
        generated += 1;
        console.log(`  ✓ ${doc.id} → ${(r.bytes / 1024).toFixed(1)} KB`);
      } else {
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ ${doc.id}: ${err?.message || err}`);
    }
  }
  console.log(`\nscanned=${scanned} eligible=${eligible} generated=${generated} skipped=${skipped} failed=${failed}${DRY ? ' [DRY-RUN]' : ''}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
