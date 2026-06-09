// Stage 150 — monthly per-agent komisi statement.
//
// Aggregates EARNED + PAID komisi rows whose `earnedAt` (for EARNED)
// or whose payout `paidAt` (for PAID) falls within the period.
// Renders a programmatic PDF (same pdfkit pattern as S101 voucher),
// stores under `private/komisi-statements/<agentId>__<YYYY-MM>.pdf`,
// records a `KomisiStatement` row.
//
// Re-running for the same period is idempotent — the upsert update-
// no-op pattern leaves the PDF + DB row untouched (a fresh render
// after data changed isn't desirable: the statement is supposed to be
// an immutable monthly artifact).
import { promises as fsp } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import PDFDocument from 'pdfkit';

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const CACHE_DIR = 'private/komisi-statements';

function pad2(n) { return String(n).padStart(2, '0'); }
function localYM(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function ymToRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);  // exclusive
  return { start, end };
}

/**
 * Stage 150 — previous calendar month's period in YYYY-MM. Cron Mon 1st
 * calls this without args to get last month.
 */
export function previousMonthYM(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return localYM(d);
}

/**
 * Stage 150 — collect the komisi line items for an agent + period.
 * Returns `{lines, totals}`. Line includes the source booking +
 * paket so the PDF can reference them.
 *
 * **Window semantics**:
 *   - EARNED rows enter the statement when `earnedAt` ∈ [periodStart, periodEnd)
 *   - PAID rows enter when the payout that consumed them landed in window
 *     (the line still appears in the agent's EARNED column for that month
 *     too if `earnedAt` was in window — but it's deduped by komisi.id)
 *
 * CANCELLED rows are excluded (undone work, not income).
 */
export async function getStatementLines({ agentId, periodYM }) {
  const { start, end } = ymToRange(periodYM);
  const rows = await db.komisi.findMany({
    where: {
      agentId,
      status: { in: ['EARNED', 'PAID'] },
      OR: [
        { earnedAt: { gte: start, lt: end } },
        { paidAt: { gte: start, lt: end } },
      ],
    },
    orderBy: { earnedAt: 'asc' },
    select: {
      id: true, amount: true, status: true,
      earnedAt: true, paidAt: true,
      booking: {
        select: {
          id: true, bookingNo: true,
          paket: { select: { slug: true, title: true } },
          jemaah: { select: { fullName: true } },
        },
      },
      payout: { select: { id: true, payoutNo: true, paidAt: true } },
    },
  });
  let totalEarned = 0, totalPaid = 0;
  for (const r of rows) {
    const amt = Number(r.amount.toString());
    if (r.status === 'EARNED') totalEarned += amt;
    else if (r.status === 'PAID') totalPaid += amt;
  }
  return {
    lines: rows,
    totals: { earnedIdr: totalEarned, paidIdr: totalPaid, lineCount: rows.length },
  };
}

/**
 * Stage 150 — render the statement PDF into a Buffer.
 */
export async function renderStatementPdfBuffer({ agent, periodYM, lines, totals }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
      Title: `Komisi Statement ${agent.displayName} · ${periodYM}`,
      Author: 'Religio Pro',
    } });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const C = { gold: '#d4af37', ink: '#0a0908', muted: '#6b6358', green: '#4a8f6d' };
    // Header
    doc.strokeColor(C.gold).lineWidth(1.5).moveTo(50, 50).lineTo(545, 50).stroke();
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink)
      .text('RELIGIO PRO', 50, 60, { width: 495, align: 'center', characterSpacing: 4 });
    doc.fontSize(9).fillColor(C.gold)
      .text('LAPORAN KOMISI BULANAN', 50, 90, { width: 495, align: 'center', characterSpacing: 3 });
    doc.strokeColor(C.gold).lineWidth(0.5).moveTo(50, 108).lineTo(545, 108).stroke();

    // Agent + period
    doc.y = 130;
    doc.font('Helvetica-Bold').fontSize(14).fillColor(C.ink).text(agent.displayName);
    doc.font('Helvetica').fontSize(10).fillColor(C.muted).text(`Slug: ${agent.slug || '—'}`);
    doc.text(`Periode: ${periodYM}`);
    doc.moveDown(0.6);

    // Totals strip
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.gold).text('RINGKASAN');
    doc.font('Helvetica').fontSize(11).fillColor(C.ink);
    doc.text(`Total EARNED : Rp ${totals.earnedIdr.toLocaleString('id-ID')}`);
    doc.text(`Total PAID   : Rp ${totals.paidIdr.toLocaleString('id-ID')}`);
    doc.text(`Jumlah baris : ${totals.lineCount}`);
    doc.moveDown(0.6);

    // Lines table
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.gold).text('RINCIAN');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(C.muted);
    if (lines.length === 0) {
      doc.text('(tidak ada transaksi pada periode ini)');
    } else {
      // Header row
      doc.fillColor(C.muted)
        .text('Tanggal', 50, doc.y, { width: 65, continued: true })
        .text('Booking', { width: 95, continued: true })
        .text('Jemaah', { width: 150, continued: true })
        .text('Status', { width: 60, continued: true })
        .text('Jumlah (Rp)', { width: 100, align: 'right' });
      doc.moveDown(0.15);
      doc.strokeColor(C.muted).lineWidth(0.3).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.15);
      for (const r of lines.slice(0, 60)) {
        const amt = Number(r.amount.toString());
        const dateRef = r.status === 'PAID' ? (r.paidAt ?? r.earnedAt) : r.earnedAt;
        doc.fillColor(C.ink).fontSize(9)
          .text(dateRef ? new Date(dateRef).toISOString().slice(0, 10) : '—', 50, doc.y, { width: 65, continued: true })
          .text(r.booking?.bookingNo || '—', { width: 95, continued: true })
          .text((r.booking?.jemaah?.fullName || '—').slice(0, 30), { width: 150, continued: true })
          .text(r.status, { width: 60, continued: true })
          .text(amt.toLocaleString('id-ID'), { width: 100, align: 'right' });
        doc.moveDown(0.1);
        if (doc.y > 760) {
          doc.addPage();
          doc.fontSize(9).fillColor(C.muted);
        }
      }
      if (lines.length > 60) {
        doc.moveDown(0.4).text(`+ ${lines.length - 60} baris lainnya — lihat /agen Wallet untuk detail lengkap`);
      }
    }

    // Footer
    const footY = doc.page.height - 60;
    doc.strokeColor(C.gold).lineWidth(0.4).moveTo(120, footY - 8).lineTo(475, footY - 8).stroke();
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted)
      .text(`Dicetak ${new Date().toISOString().slice(0, 10)} · Religio Pro · Statement tidak mengikat secara hukum`,
        50, footY, { width: 495, align: 'center' });

    doc.end();
  });
}

/**
 * Stage 150 — generate the statement for one agent + period. Idempotent:
 * if `KomisiStatement(agentId, periodYM)` already exists, returns the
 * existing row + PDF path without re-rendering.
 *
 * Returns `{statement, created, pdfPath}`.
 */
export async function generateAgentStatement({ req = null, actor = null, agentId, periodYM, now = new Date() } = {}) {
  if (!agentId) throw new HttpError(400, 'agentId wajib', 'BAD_AGENT');
  if (!/^\d{4}-\d{2}$/.test(periodYM)) {
    throw new HttpError(400, 'periodYM harus format YYYY-MM', 'BAD_PERIOD');
  }
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: { id: true, slug: true, displayName: true },
  });
  if (!agent) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');

  // Already exists? Return as-is.
  const existing = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId, periodYM } },
  });
  if (existing) {
    return { statement: existing, created: false, pdfPath: existing.pdfPath };
  }

  const { lines, totals } = await getStatementLines({ agentId, periodYM });
  // Render + persist PDF
  const buffer = await renderStatementPdfBuffer({ agent, periodYM, lines, totals });
  const dir = resolvePath(process.cwd(), CACHE_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${agentId}__${periodYM}.pdf`;
  const pdfPath = joinPath(dir, fileName);
  await fsp.writeFile(pdfPath, buffer);

  const statement = await db.komisiStatement.create({
    data: {
      agentId, periodYM,
      totalEarnedIdr: totals.earnedIdr.toFixed(2),
      totalPaidIdr: totals.paidIdr.toFixed(2),
      lineCount: totals.lineCount,
      pdfPath,
      generatedAt: now,
    },
  });

  await audit({
    req, actor: actor ?? { email: 'system' },
    action: 'CREATE', entity: 'KomisiStatement', entityId: statement.id,
    after: {
      agentSlug: agent.slug, periodYM,
      totalEarnedIdr: totals.earnedIdr,
      totalPaidIdr: totals.paidIdr,
      lineCount: totals.lineCount,
    },
  }).catch((err) => console.warn('[komisi-statement] audit failed:', err?.message || err));

  return { statement, created: true, pdfPath };
}

/**
 * Stage 151 — admin override: delete the existing statement + PDF on
 * disk for `(agentId, periodYM)` then re-run `generateAgentStatement`.
 * Used when a late komisi adjustment landed AFTER the original cron
 * pass — S150's immutability rule was the right default but admins
 * still need an escape hatch.
 *
 * Audit row carries the prior totals so a compliance scan can answer
 * "did the statement amount change retroactively?".
 */
export async function regenerateAgentStatement({ req = null, actor = null, agentId, periodYM, now = new Date() } = {}) {
  if (!agentId) throw new HttpError(400, 'agentId wajib', 'BAD_AGENT');
  if (!/^\d{4}-\d{2}$/.test(periodYM)) {
    throw new HttpError(400, 'periodYM harus format YYYY-MM', 'BAD_PERIOD');
  }
  const existing = await db.komisiStatement.findUnique({
    where: { agentId_periodYM: { agentId, periodYM } },
  });
  // Capture prior totals + PDF path for audit + cleanup BEFORE the
  // delete. Missing existing row is fine — falls through to generate.
  const prior = existing ? {
    totalEarnedIdr: Number(existing.totalEarnedIdr.toString()),
    totalPaidIdr: Number(existing.totalPaidIdr.toString()),
    lineCount: existing.lineCount,
    pdfPath: existing.pdfPath,
  } : null;
  if (existing) {
    await db.komisiStatement.delete({ where: { id: existing.id } });
    // Best-effort PDF cleanup — a missing file isn't fatal.
    if (existing.pdfPath) {
      await fsp.unlink(existing.pdfPath).catch(() => { /* swallow */ });
    }
  }

  // Now run the canonical create path.
  const result = await generateAgentStatement({ req, actor, agentId, periodYM, now });

  // Audit annotation: which prior totals were superseded.
  await audit({
    req, actor: actor ?? { email: 'system' },
    action: 'UPDATE', entity: 'KomisiStatement', entityId: result.statement.id,
    before: prior ?? { existed: false },
    after: {
      regenerated: true, periodYM,
      totalEarnedIdr: Number(result.statement.totalEarnedIdr.toString()),
      totalPaidIdr: Number(result.statement.totalPaidIdr.toString()),
      lineCount: result.statement.lineCount,
    },
  }).catch((err) => console.warn('[komisi-statement] regen audit failed:', err?.message || err));

  return { ...result, regenerated: true, prior };
}

/**
 * Stage 150 — iterate every ACTIVE agent + generate the previous-month
 * statement. Per-agent failures are caught + logged so a bad row doesn't
 * abort the batch.
 */
export async function generateAllAgentStatements({ req = null, actor = null, periodYM = previousMonthYM(), now = new Date() } = {}) {
  const agents = await db.agentProfile.findMany({
    where: { user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, slug: true },
  });
  let created = 0, skipped = 0, errors = 0;
  for (const a of agents) {
    try {
      const r = await generateAgentStatement({ req, actor, agentId: a.id, periodYM, now });
      if (r.created) created += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[komisi-statement] agent ${a.slug} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { agentCount: agents.length, created, skipped, errors, periodYM };
}

/**
 * Stage 150 — agent-facing listing for /agen Wallet tab.
 */
export async function listAgentStatements({ agentId, limit = 24 } = {}) {
  return db.komisiStatement.findMany({
    where: { agentId },
    orderBy: { periodYM: 'desc' },
    take: limit,
    select: {
      id: true, periodYM: true,
      totalEarnedIdr: true, totalPaidIdr: true, lineCount: true,
      pdfPath: true, generatedAt: true,
    },
  });
}

export { CACHE_DIR };
