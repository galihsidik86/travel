// Stage 149 — voucher PDF cache.
//
// Renders are content-addressed: cache key = `<bookingId>__<lang>__<hash>`
// where `hash` summarises every voucher field the PDF actually displays
// (bookingNo / status / total / paid / jemaah identity / room / paket
// times / agent / payment history). When any of those change the hash
// changes → cache miss → fresh render → old hash file deleted.
//
// Files live under `private/voucher-cache/` (covered by SENSITIVE_PREFIXES
// so they're not publicly served). Best-effort throughout — a write
// failure logs + returns the freshly-rendered buffer, never crashes.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';

import { renderVoucherPdfBuffer, pickLang } from './bookingVoucherPdf.js';

const CACHE_DIR = 'private/voucher-cache';

/**
 * Stage 149 — compute the cache-invalidation hash for one voucher.
 * Order matters for determinism — keep this serialiser stable.
 */
export function hashVoucher(voucher) {
  const h = createHash('sha256');
  h.update(JSON.stringify({
    bookingNo: voucher.bookingNo,
    status: voucher.status,
    kelas: voucher.kelas,
    paxCount: voucher.paxCount,
    totalAmount: voucher.totalAmount,
    paidAmount: voucher.paidAmount,
    paket: voucher.paket && {
      slug: voucher.paket.slug,
      title: voucher.paket.title,
      departureDate: voucher.paket.departureDate,
      returnDate: voucher.paket.returnDate,
      airline: voucher.paket.airline,
      routeFrom: voucher.paket.routeFrom,
      routeTo: voucher.paket.routeTo,
      // Itinerary day count + titles matter; specifics like times don't
      // change the rendered list.
      days: (voucher.paket.days || []).map((d) => ({ n: d.dayNumber, t: d.title })),
    },
    jemaah: voucher.jemaah && {
      fullName: voucher.jemaah.fullName,
      phone: voucher.jemaah.phone,
      email: voucher.jemaah.email,
      passportNo: voucher.jemaah.passportNo,
      passportExpiry: voucher.jemaah.passportExpiry,
    },
    room: voucher.room && {
      roomNo: voucher.room.roomNo,
    },
    agent: voucher.agent && {
      slug: voucher.agent.slug,
      displayName: voucher.agent.displayName,
      whatsapp: voucher.agent.whatsapp,
    },
    // Payment history rolls into hash so a new payment / refund
    // invalidates the cache automatically.
    payments: (voucher.payments || []).map((p) => ({
      id: p.id,
      amount: typeof p.amount === 'object' ? p.amount.toString() : String(p.amount),
      status: p.status,
      method: p.method,
      createdAt: p.createdAt,
    })),
    // Stage 287 — add-ons in the hash so attach/remove (which
    // doesn't change paid/total directly the way payments do, but
    // does change totalAmount via S284 transaction) busts the cache
    // alongside.
    addons: (voucher.addons || []).map((a) => ({
      name: a.name,
      qty: a.quantity,
      // priceIdr is the snapshot — already a Number in the shape()
      price: a.priceIdr,
    })),
  }));
  return h.digest('hex').slice(0, 16);
}

/**
 * Stage 149 — get the voucher PDF buffer, hitting cache when fresh OR
 * rendering + persisting when not. Returns `{buffer, cached, filePath, hash}`.
 *
 * Best-effort persistence: a write failure logs but still returns the
 * freshly-rendered buffer to the caller. Same for stale-cleanup of
 * older hash files for the same (bookingId, lang) prefix.
 */
export async function getOrRenderVoucherPdf({ bookingId, voucher, lang = 'id' } = {}) {
  if (!bookingId) throw new Error('getOrRenderVoucherPdf: bookingId required');
  const langKey = pickLang(lang);
  const hash = hashVoucher(voucher);
  const dir = resolvePath(process.cwd(), CACHE_DIR);
  const fileName = `${bookingId}__${langKey}__${hash}.pdf`;
  const filePath = joinPath(dir, fileName);

  // Cache hit
  try {
    const buffer = await fsp.readFile(filePath);
    return { buffer, cached: true, filePath, hash };
  } catch (_e) {
    // Miss — fall through to render
  }

  // Render fresh
  const buffer = await renderVoucherPdfBuffer(voucher, { lang: langKey });

  // Persist (best-effort)
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, buffer);
    // Clean up stale variants for the same (bookingId, lang) — old hashes
    // are dead weight once a fresh render has succeeded. Don't touch
    // OTHER (bookingId, lang) entries.
    await cleanupStaleVariants(dir, bookingId, langKey, hash).catch(() => { /* swallow */ });
  } catch (err) {
    console.warn('[voucherCache] persist failed:', err?.message || err);
  }

  return { buffer, cached: false, filePath, hash };
}

async function cleanupStaleVariants(dir, bookingId, lang, currentHash) {
  const prefix = `${bookingId}__${lang}__`;
  const keepName = `${prefix}${currentHash}.pdf`;
  const files = await fsp.readdir(dir).catch(() => []);
  for (const f of files) {
    if (f.startsWith(prefix) && f !== keepName) {
      await fsp.unlink(joinPath(dir, f)).catch(() => { /* swallow */ });
    }
  }
}

export { CACHE_DIR };
