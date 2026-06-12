// Stage 239 — jemaah self-service data export. Streams a ZIP with
// the jemaah's own data (profile, bookings, payments, docs metadata,
// notifications) as CSVs + the actual uploaded doc files.
//
// Aligned with UU PDP article 5 (right to data portability) and the
// general "user owns their data" stance. Admin-internal content is
// excluded — notes, mentions, tasks, internal audit fields.
//
// Streamed via `archiver` (no temp file on disk; mirrors S105 bundle
// pattern). Per-file failure logged in MANIFEST.txt as "NOT INCLUDED"
// — partial export is better than no export.

// archiver v8+ is pure ESM and exposes named classes (mirrors S105).
import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  // UTF-8 BOM + CRLF for Excel compatibility, matching S138/S165 convention
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/**
 * Loads everything a jemaah is entitled to download. Returns a payload
 * object the streaming function archives. Caller must enforce ownership
 * (`userId` is the calling user's id — service trusts it).
 */
export async function buildJemaahDataExportPayload({ userId }) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, fullName: true, phone: true,
      role: true, status: true, createdAt: true,
      jemaah: {
        select: {
          id: true, fullName: true, nik: true, passportNo: true,
          passportExpiry: true, birthDate: true, gender: true,
          phone: true, email: true, address: true,
          emergencyContact: true, notes: true,
          notifEmail: true, notifWa: true,
          notifWaConsentAt: true, notifWaWithdrawnAt: true,
          dietary: true, dietaryNotes: true,
        },
      },
    },
  });
  if (!user) return null;

  const jemaahId = user.jemaah?.id || null;
  // Bookings (where this user is the linked jemaah)
  const bookings = jemaahId
    ? await db.booking.findMany({
        where: { OR: [{ jemaahUserId: userId }, { jemaahId }] },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, bookingNo: true, status: true,
          kelas: true, paxCount: true,
          totalAmount: true, paidAmount: true, currency: true,
          notes: true, // their own notes input at booking time (form data)
          cancelledAt: true, cancelReason: true, cancelReasonCode: true,
          createdAt: true, updatedAt: true,
          paket: { select: { slug: true, title: true, departureDate: true, returnDate: true } },
        },
      })
    : [];
  const bookingIds = bookings.map((b) => b.id);

  // Payments tied to those bookings
  const payments = bookingIds.length > 0
    ? await db.payment.findMany({
        where: { bookingId: { in: bookingIds } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, bookingId: true,
          amount: true, currency: true, method: true, status: true,
          paidAt: true, createdAt: true,
          refundReasonCode: true,
        },
      })
    : [];

  // Documents (with file metadata + on-disk path so we can include the files)
  const documents = jemaahId
    ? await db.jemaahDocument.findMany({
        where: { jemaahId },
        orderBy: { type: 'asc' },
        select: {
          id: true, type: true, status: true, refNumber: true,
          expiresAt: true, submittedAt: true, verifiedAt: true,
          fileName: true, filePath: true, fileSize: true, mimeType: true,
          createdAt: true,
        },
      })
    : [];

  // Notifications (recipientUserId scope)
  const notifications = await db.notification.findMany({
    where: { recipientUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      id: true, type: true, channel: true, status: true,
      subject: true, body: true,
      sentAt: true, createdAt: true, readAt: true,
    },
  });

  return { user, bookings, payments, documents, notifications };
}

/**
 * Streams a ZIP archive containing CSVs + uploaded doc files. Pipes
 * into `res` directly — caller sets headers + invokes finalize.
 *
 * Layout inside the ZIP:
 *   /MANIFEST.txt
 *   /profile.csv          one-row profile snapshot
 *   /bookings.csv         all bookings
 *   /payments.csv         all payments (PAID + REFUNDED rows)
 *   /documents.csv        doc metadata (status, refNumber, etc.)
 *   /notifications.csv    inbox snapshot
 *   /docs/<docId>__<filename>   actual uploaded files
 */
export async function streamJemaahDataExport(payload, res) {
  if (!payload) throw new Error('payload missing');
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(res);

  const exportedAt = new Date().toISOString();
  const manifestLines = [
    `Religio Pro — Jemaah data export`,
    `Akun: ${payload.user.email} · ${payload.user.fullName}`,
    `Diekspor pada: ${exportedAt}`,
    `Disusun sesuai hak portabilitas data (UU PDP).`,
    '',
    'ISI ARSIP:',
  ];

  // profile.csv (one row)
  if (payload.user.jemaah) {
    const j = payload.user.jemaah;
    const profile = {
      userEmail: payload.user.email,
      userFullName: payload.user.fullName,
      userPhone: payload.user.phone,
      userCreatedAt: payload.user.createdAt?.toISOString?.() || '',
      jemaahFullName: j.fullName,
      jemaahNIK: j.nik,
      jemaahPassportNo: j.passportNo,
      jemaahPassportExpiry: j.passportExpiry?.toISOString?.()?.slice(0, 10) || '',
      jemaahBirthDate: j.birthDate?.toISOString?.()?.slice(0, 10) || '',
      jemaahGender: j.gender,
      jemaahPhone: j.phone,
      jemaahEmail: j.email,
      jemaahAddress: j.address,
      jemaahEmergencyContact: j.emergencyContact,
      jemaahNotes: j.notes,
      notifEmail: j.notifEmail,
      notifWa: j.notifWa,
      notifWaConsentAt: j.notifWaConsentAt?.toISOString?.() || '',
      notifWaWithdrawnAt: j.notifWaWithdrawnAt?.toISOString?.() || '',
      dietary: j.dietary,
      dietaryNotes: j.dietaryNotes,
    };
    archive.append(
      buildCsv(Object.keys(profile), [profile]),
      { name: 'profile.csv' },
    );
    manifestLines.push('  ✓ profile.csv');
  } else {
    manifestLines.push('  ✗ profile.csv (tidak ada profil jemaah terkait)');
  }

  // bookings.csv
  const bookingRows = payload.bookings.map((b) => ({
    bookingNo: b.bookingNo,
    paketSlug: b.paket?.slug,
    paketTitle: b.paket?.title,
    departureDate: b.paket?.departureDate?.toISOString?.()?.slice(0, 10) || '',
    returnDate: b.paket?.returnDate?.toISOString?.()?.slice(0, 10) || '',
    status: b.status,
    kelas: b.kelas,
    paxCount: b.paxCount,
    totalAmount: toNumber(b.totalAmount),
    paidAmount: toNumber(b.paidAmount),
    currency: b.currency,
    notes: b.notes,
    cancelledAt: b.cancelledAt?.toISOString?.() || '',
    cancelReason: b.cancelReason,
    cancelReasonCode: b.cancelReasonCode,
    createdAt: b.createdAt?.toISOString?.() || '',
  }));
  archive.append(
    buildCsv(
      ['bookingNo', 'paketSlug', 'paketTitle', 'departureDate', 'returnDate', 'status', 'kelas', 'paxCount', 'totalAmount', 'paidAmount', 'currency', 'notes', 'cancelledAt', 'cancelReason', 'cancelReasonCode', 'createdAt'],
      bookingRows,
    ),
    { name: 'bookings.csv' },
  );
  manifestLines.push(`  ✓ bookings.csv (${bookingRows.length} baris)`);

  // payments.csv
  const paymentRows = payload.payments.map((p) => ({
    paymentId: p.id,
    bookingId: p.bookingId,
    amount: toNumber(p.amount),
    currency: p.currency,
    method: p.method,
    status: p.status,
    paidAt: p.paidAt?.toISOString?.() || '',
    createdAt: p.createdAt?.toISOString?.() || '',
    refundReasonCode: p.refundReasonCode,
  }));
  archive.append(
    buildCsv(
      ['paymentId', 'bookingId', 'amount', 'currency', 'method', 'status', 'paidAt', 'createdAt', 'refundReasonCode'],
      paymentRows,
    ),
    { name: 'payments.csv' },
  );
  manifestLines.push(`  ✓ payments.csv (${paymentRows.length} baris)`);

  // documents.csv
  const docRows = payload.documents.map((d) => ({
    documentId: d.id,
    type: d.type,
    status: d.status,
    refNumber: d.refNumber,
    expiresAt: d.expiresAt?.toISOString?.()?.slice(0, 10) || '',
    submittedAt: d.submittedAt?.toISOString?.() || '',
    verifiedAt: d.verifiedAt?.toISOString?.() || '',
    fileName: d.fileName,
    fileSize: d.fileSize,
    mimeType: d.mimeType,
  }));
  archive.append(
    buildCsv(
      ['documentId', 'type', 'status', 'refNumber', 'expiresAt', 'submittedAt', 'verifiedAt', 'fileName', 'fileSize', 'mimeType'],
      docRows,
    ),
    { name: 'documents.csv' },
  );
  manifestLines.push(`  ✓ documents.csv (${docRows.length} baris)`);

  // notifications.csv
  const notifRows = payload.notifications.map((n) => ({
    notifId: n.id,
    type: n.type,
    channel: n.channel,
    status: n.status,
    subject: n.subject,
    body: (n.body || '').slice(0, 4000), // cap to avoid runaway
    sentAt: n.sentAt?.toISOString?.() || '',
    createdAt: n.createdAt?.toISOString?.() || '',
    readAt: n.readAt?.toISOString?.() || '',
  }));
  archive.append(
    buildCsv(
      ['notifId', 'type', 'channel', 'status', 'subject', 'body', 'sentAt', 'createdAt', 'readAt'],
      notifRows,
    ),
    { name: 'notifications.csv' },
  );
  manifestLines.push(`  ✓ notifications.csv (${notifRows.length} baris)`);

  // Actual doc files
  manifestLines.push('', 'DOKUMEN TER-UPLOAD:');
  for (const d of payload.documents) {
    if (!d.filePath) {
      manifestLines.push(`  ✗ ${d.type} — tidak ada file ter-upload`);
      continue;
    }
    try {
      if (fs.existsSync(d.filePath)) {
        const safeName = (d.fileName || `${d.type}-${d.id}`).replace(/[^A-Za-z0-9._-]/g, '_');
        archive.file(d.filePath, { name: `docs/${d.id}__${safeName}` });
        manifestLines.push(`  ✓ docs/${d.id}__${safeName}`);
      } else {
        manifestLines.push(`  ✗ ${d.type} — file tidak ditemukan di disk`);
      }
    } catch (err) {
      manifestLines.push(`  ✗ ${d.type} — error: ${err?.message || err}`);
    }
  }

  archive.append(manifestLines.join('\n'), { name: 'MANIFEST.txt' });

  await archive.finalize();
}
