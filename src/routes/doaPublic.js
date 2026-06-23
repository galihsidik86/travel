// Stage 389 — public read API untuk doa list. No auth — doa adalah
// general religious content yang non-personal. PWA jemaah fetch saat
// load /saya/ibadah dengan fallback ke localStorage cache untuk offline.

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listActiveDoa, effectiveAudioUrl } from '../services/doa.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const rows = await listActiveDoa();
  // Shape match shared/doa-harian.js untuk drop-in compatibility.
  const doa = rows.map((d) => ({
    id: d.id,
    title: d.title,
    arabic: d.arabic || '',
    latin: d.latin || '',
    translation: d.translation || '',
    audioUrl: effectiveAudioUrl(d),
    videoUrl: d.videoUrl || null,
    category: d.category || null,
    audioCredit: d.credit || null,
  }));
  // Allow CDN cache for 5 min — admin edits ada delay 5 min sampai PWA
  // pickup, acceptable trade-off untuk reduce server load.
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ok: true, doa, fetchedAt: new Date().toISOString() });
}));

export default router;
