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
export async function getStatementLines({ agentId, periodYM, paketId = null }) {
  const { start, end } = ymToRange(periodYM);
  const where = {
    agentId,
    status: { in: ['EARNED', 'PAID'] },
    OR: [
      { earnedAt: { gte: start, lt: end } },
      { paidAt: { gte: start, lt: end } },
    ],
  };
  // Stage 159 — optional paket scope. Filter to komisi whose source
  // booking lives on this paket. Used by the dispute-resolution
  // statement that needs to answer "what did agent X earn from
  // paket Y this period?".
  if (paketId) where.booking = { paketId };
  const rows = await db.komisi.findMany({
    where,
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
 * Stage 155 — compute YTD running totals for the agent across the
 * calendar year of `periodYM`. Returns three slices:
 *   - before  : Jan 1 → first day of periodYM (exclusive)
 *   - during  : the period itself
 *   - after   : Jan 1 → end of periodYM (inclusive)
 *
 * The PDF block shows all three so the agent sees the running tape
 * without flipping between statements.
 *
 * `suppressed: true` when periodYM is January AND "before" totals are
 * 0 — no signal worth rendering (the PDF helper skips the block).
 */
export async function computeYtdTotals({ agentId, periodYM }) {
  const [year, monthStr] = periodYM.split('-').map(Number);
  const monthIdx0 = monthStr - 1;
  const yearStart = new Date(year, 0, 1);
  const periodStart = new Date(year, monthIdx0, 1);
  const periodEnd = new Date(year, monthIdx0 + 1, 1);  // exclusive
  const sumWindow = async (gte, lt) => {
    const rows = await db.komisi.findMany({
      where: {
        agentId,
        status: { in: ['EARNED', 'PAID'] },
        OR: [
          { earnedAt: { gte, lt } },
          { paidAt: { gte, lt } },
        ],
      },
      select: { amount: true, status: true },
    });
    let e = 0, p = 0;
    for (const r of rows) {
      const v = Number(r.amount.toString());
      if (r.status === 'EARNED') e += v;
      else if (r.status === 'PAID') p += v;
    }
    return { earnedIdr: e, paidIdr: p, count: rows.length };
  };

  const before = await sumWindow(yearStart, periodStart);
  const during = await sumWindow(periodStart, periodEnd);
  const after  = await sumWindow(yearStart, periodEnd);
  return {
    year,
    before, during, after,
    suppressed: monthIdx0 === 0 && before.count === 0,
  };
}

/**
 * Stage 150 — render the statement PDF into a Buffer. S155 adds the
 * optional YTD block when `ytd` is provided + not suppressed.
 */
export async function renderStatementPdfBuffer({ agent, periodYM, lines, totals, ytd = null, adminNote = null }) {
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

    // Stage 155 — YTD running totals. Suppressed when there's no
    // pre-period signal (e.g. January with no rollover from last
    // year's pre-S155 deployments).
    if (ytd && !ytd.suppressed) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.gold)
        .text(`YTD ${ytd.year} (komulatif)`);
      doc.font('Helvetica').fontSize(10).fillColor(C.muted);
      const fmtRp = (n) => 'Rp ' + n.toLocaleString('id-ID');
      // Three-row mini table: before / during / after period
      const tableY = doc.y + 4;
      const rows = [
        ['Sebelum periode ini', ytd.before.earnedIdr, ytd.before.paidIdr],
        ['Selama periode ini',  ytd.during.earnedIdr, ytd.during.paidIdr],
        ['Setelah periode ini', ytd.after.earnedIdr,  ytd.after.paidIdr],
      ];
      // Header
      doc.fontSize(9).fillColor(C.muted)
        .text('Window', 50, tableY, { width: 220, continued: true })
        .text('EARNED', { width: 130, align: 'right', continued: true })
        .text('PAID', { width: 130, align: 'right' });
      doc.moveDown(0.15);
      doc.strokeColor(C.muted).lineWidth(0.3).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.15);
      for (const [label, e, p] of rows) {
        const isAfter = label.startsWith('Setelah');
        const labelColor = isAfter ? C.ink : C.muted;
        const valColor = isAfter ? C.green : C.ink;
        doc.font(isAfter ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(isAfter ? 10 : 9).fillColor(labelColor)
          .text(label, 50, doc.y, { width: 220, continued: true });
        doc.fillColor(valColor)
          .text(fmtRp(e), { width: 130, align: 'right', continued: true })
          .text(fmtRp(p), { width: 130, align: 'right' });
        doc.moveDown(0.15);
      }
      doc.moveDown(0.4);
    }

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

    // Stage 156 — optional admin note. Renders as a gold-bordered
    // block at the end of the body, before the footer. Trim whitespace
    // (no leading blank lines) so a 1-line note doesn't waste space.
    if (adminNote && adminNote.trim()) {
      doc.moveDown(0.6);
      const startY = doc.y;
      const padX = 12, padY = 10;
      const innerW = 495 - padX * 2;
      // Pre-measure the text height to draw the box around it
      doc.font('Helvetica').fontSize(10).fillColor(C.ink);
      const noteText = adminNote.trim();
      const textH = doc.heightOfString(noteText, { width: innerW });
      const titleH = 14;  // approx for the small caps header
      const boxH = titleH + textH + padY * 2;
      // Box border (gold, slight ruby tint via stroke color tweak — keep gold for brand consistency)
      doc.strokeColor(C.gold).lineWidth(0.6)
        .rect(50, startY, 495, boxH).stroke();
      // Title strip
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gold)
        .text('CATATAN DARI RELIGIO PRO', 50 + padX, startY + padY,
          { width: innerW, characterSpacing: 1.5 });
      // Body
      doc.font('Helvetica').fontSize(10).fillColor(C.ink)
        .text(noteText, 50 + padX, startY + padY + titleH, { width: innerW });
      doc.y = startY + boxH + 4;
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
export async function generateAgentStatement({ req = null, actor = null, agentId, periodYM, now = new Date(), adminNote = null } = {}) {
  if (!agentId) throw new HttpError(400, 'agentId wajib', 'BAD_AGENT');
  if (!/^\d{4}-\d{2}$/.test(periodYM)) {
    throw new HttpError(400, 'periodYM harus format YYYY-MM', 'BAD_PERIOD');
  }
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    // S152: select user email/id so notifyKomisiStatementReady can fire
    // post-create without an extra round-trip.
    select: {
      id: true, slug: true, displayName: true, userId: true,
      // S157 — opt-out flag flows into the notif helper
      notifKomisiStatement: true,
      user: { select: { email: true, status: true, deletedAt: true } },
    },
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
  // Stage 155 — YTD running totals. Best-effort: compute failure
  // (shouldn't happen for cheap groupBy queries, but defensive) just
  // means the PDF renders without the YTD block.
  let ytd = null;
  try {
    ytd = await computeYtdTotals({ agentId, periodYM });
  } catch (err) {
    console.warn('[komisi-statement] YTD compute failed:', err?.message || err);
  }
  // S156 — normalise admin note (trim + cap; empty → null) and thread
  // through to the PDF render so it appears as a "Catatan dari
  // Religio Pro" block. NULL note → no block.
  const cleanNote = adminNote == null ? null : (String(adminNote).trim().slice(0, 2000) || null);

  // Render + persist PDF
  const buffer = await renderStatementPdfBuffer({
    agent, periodYM, lines, totals, ytd, adminNote: cleanNote,
  });
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
      adminNote: cleanNote,
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

  // Stage 152 — fire one EMAIL to the agent (silent on zero-line
  // statements + when agent has no email or is inactive). Fire-and-
  // forget so notif failure can't abort the statement creation.
  if (statement.lineCount > 0
      && agent.user?.email
      && agent.user?.status === 'ACTIVE'
      && !agent.user?.deletedAt) {
    try {
      const { notifyKomisiStatementReady } = await import('./notifications.js');
      await notifyKomisiStatementReady({
        statement,
        agent: {
          displayName: agent.displayName, slug: agent.slug,
          email: agent.user.email, userId: agent.userId,
          // S157 — pass the opt-out flag through
          notifKomisiStatement: agent.notifKomisiStatement,
        },
      });
    } catch (err) {
      console.warn('[komisi-statement] notif fire failed:', err?.message || err);
    }
  }

  return { statement, created: true, pdfPath };
}

/**
 * Stage 159 — render a transient (non-persisted) per-paket statement
 * for dispute resolution. Caller pipes the returned buffer to res.
 * Doesn't create a `KomisiStatement` row, doesn't write a file under
 * `private/komisi-statements/`, doesn't fire a notif. Pure read-only
 * snapshot for the admin to send the agent during a dispute.
 *
 * The PDF carries the same shape as the regular statement but with
 * the paket title in the header subtitle so it's obvious this isn't
 * the canonical monthly artifact.
 */
export async function renderPaketScopedStatementBuffer({ agentId, periodYM, paketId }) {
  if (!agentId) throw new HttpError(400, 'agentId wajib', 'BAD_AGENT');
  if (!/^\d{4}-\d{2}$/.test(periodYM)) {
    throw new HttpError(400, 'periodYM harus format YYYY-MM', 'BAD_PERIOD');
  }
  if (!paketId) throw new HttpError(400, 'paketId wajib', 'BAD_PAKET');
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: { id: true, slug: true, displayName: true },
  });
  if (!agent) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');
  const paket = await db.paket.findUnique({
    where: { id: paketId }, select: { id: true, slug: true, title: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

  const { lines, totals } = await getStatementLines({ agentId, periodYM, paketId });
  // Decorate the agent display so the PDF header makes the scope clear
  const buffer = await renderStatementPdfBuffer({
    agent: { ...agent, displayName: `${agent.displayName} · scope: ${paket.title}` },
    periodYM, lines, totals,
    // No YTD block — paket-scoped doesn't have an annual notion that
    // matches the rest of the running tape.
    ytd: null,
    adminNote: `Statement khusus paket "${paket.title}" — bukan rekap bulanan kanonik. Dibuat oleh admin untuk klarifikasi.`,
  });
  return { buffer, agent, paket, periodYM, totals };
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
export async function regenerateAgentStatement({ req = null, actor = null, agentId, periodYM, now = new Date(), adminNote } = {}) {
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
    adminNote: existing.adminNote,
  } : null;
  if (existing) {
    await db.komisiStatement.delete({ where: { id: existing.id } });
    // Best-effort PDF cleanup — a missing file isn't fatal.
    if (existing.pdfPath) {
      await fsp.unlink(existing.pdfPath).catch(() => { /* swallow */ });
    }
  }

  // S156 — normalise the note (trim + cap 2000 chars; empty → null).
  // Caller may pass `adminNote=undefined` to preserve the prior note
  // on regen; explicit `null` or `''` clears it.
  let noteForCreate;
  if (adminNote === undefined) {
    noteForCreate = prior?.adminNote ?? null;
  } else {
    noteForCreate = (adminNote || '').trim().slice(0, 2000) || null;
  }

  // Now run the canonical create path with the note.
  const result = await generateAgentStatement({
    req, actor, agentId, periodYM, now, adminNote: noteForCreate,
  });

  // Audit annotation: which prior totals + note were superseded.
  await audit({
    req, actor: actor ?? { email: 'system' },
    action: 'UPDATE', entity: 'KomisiStatement', entityId: result.statement.id,
    before: prior ?? { existed: false },
    after: {
      regenerated: true, periodYM,
      totalEarnedIdr: Number(result.statement.totalEarnedIdr.toString()),
      totalPaidIdr: Number(result.statement.totalPaidIdr.toString()),
      lineCount: result.statement.lineCount,
      adminNote: noteForCreate,
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
  // Stage 154 — opt-out: when env flag is set, agents with zero komisi
  // lines for the period skip the create entirely (no row + no PDF).
  // Keeps the agent wallet tab tidy for agents who didn't sell anything
  // that month. Default off (back-compat with the S150 "always create"
  // behavior). Reads env at call time so runtime toggles / tests work
  // without a restart. ADMIN regenerate path (S151) NEVER honors this
  // flag — explicit admin action always produces a statement.
  const skipZeroLines = process.env.KOMISI_STATEMENT_SKIP_ZERO_LINES === 'true';
  let created = 0, skipped = 0, zeroSkipped = 0, errors = 0;
  for (const a of agents) {
    try {
      if (skipZeroLines) {
        // Cheap pre-check via getStatementLines — avoids rendering the
        // PDF + creating the row when we'd skip anyway.
        const { totals } = await getStatementLines({ agentId: a.id, periodYM });
        if (totals.lineCount === 0) {
          // Only count as zero-skip when there ISN'T already an existing
          // row for this period (existing row → skipped via the normal
          // idempotency path).
          const existing = await db.komisiStatement.findUnique({
            where: { agentId_periodYM: { agentId: a.id, periodYM } },
            select: { id: true },
          });
          if (!existing) {
            zeroSkipped += 1;
            continue;
          }
        }
      }
      const r = await generateAgentStatement({ req, actor, agentId: a.id, periodYM, now });
      if (r.created) created += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[komisi-statement] agent ${a.slug} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { agentCount: agents.length, created, skipped, zeroSkipped, errors, periodYM };
}

/**
 * Stage 153 — backfill helper. Walks backwards from `previousMonthYM()`
 * for `months` periods and runs `generateAllAgentStatements` per
 * period. Idempotent: existing (agent, period) statements skip via
 * `generateAgentStatement`'s upsert-style early-return.
 *
 * Used for first-install / new-deployment seeding when the past few
 * months of statements don't exist yet. CLI front-end accepts
 * `--months=N` (default 6, cap 24 — beyond two years is a deliberate
 * one-off).
 */
export async function backfillKomisiStatements({ req = null, actor = null, months = 6, now = new Date() } = {}) {
  const cap = Math.max(1, Math.min(24, Math.trunc(months) || 6));
  const perMonth = [];
  let grandCreated = 0, grandSkipped = 0, grandZeroSkipped = 0, grandErrors = 0;
  for (let i = 0; i < cap; i++) {
    // i=0 → previousMonth, i=1 → two months ago, etc.
    const d = new Date(now.getFullYear(), now.getMonth() - 1 - i, 1);
    const periodYM = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    try {
      const r = await generateAllAgentStatements({ req, actor, periodYM, now });
      perMonth.push({ periodYM, ...r });
      grandCreated += r.created;
      grandSkipped += r.skipped;
      grandZeroSkipped += (r.zeroSkipped || 0);
      grandErrors += r.errors;
    } catch (err) {
      console.warn(`[backfill-komisi] period ${periodYM} failed:`, err?.message || err);
      grandErrors += 1;
      perMonth.push({ periodYM, agentCount: 0, created: 0, skipped: 0, zeroSkipped: 0, errors: 1 });
    }
  }
  return {
    monthsRequested: cap,
    perMonth,
    totals: { created: grandCreated, skipped: grandSkipped, zeroSkipped: grandZeroSkipped, errors: grandErrors },
  };
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
      // S156 — admin note for the wallet-tab badge "✎ catatan"
      adminNote: true,
    },
  });
}

export { CACHE_DIR };
