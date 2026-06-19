// Stage 382 — UU PDP article 6 consent receipt.
//
// Jemaah downloadable PDF proof of:
//   - When their account was created (implicit consent baseline)
//   - Each communication channel consent (WA + EMAIL + engagement)
//     with consent + withdrawal timestamps
//   - Account events from AuditLog (LOGIN/LOGOUT/profile updates)
//   - Data controller identity + contact (Religio Pro)
//   - Retention windows declared
//
// UU PDP 2022 (Pasal 14-15): data subjects have the right to a clear,
// downloadable, dated proof of consent that they can present back if
// challenged. This PDF is that artifact.

import { db } from '../lib/db.js';
import PDFDocument from 'pdfkit';

const DATA_CONTROLLER = {
  name: 'PT Religio Pro Tour & Travel',
  email: 'privasi@religio.pro',
  phone: '+62 21 0000 0000',
  address: 'Jakarta, Indonesia',
};

const RETENTION_NOTES = [
  ['Akun jemaah', 'disimpan selama akun aktif; permintaan penghapusan via /saya/privasi'],
  ['Audit log', '2 tahun pada DB aktif, kemudian diarsipkan terenkripsi'],
  ['Riwayat pembayaran', 'disimpan permanen (kewajiban akuntansi)'],
  ['Notifikasi yang sudah terkirim', '90 hari (SENT) / 180 hari (gagal terminal)'],
  ['File dokumen (paspor dll)', 'sampai dihapus jemaah atau akun dihapus'],
];

export async function getConsentReceiptData(userId) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, fullName: true, phone: true,
      role: true, createdAt: true, lastLoginAt: true, status: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true, email: true,
          notifEmail: true, notifWa: true, notifEngagement: true,
          notifWaConsentAt: true, notifWaWithdrawnAt: true,
        },
      },
    },
  });
  if (!user) return null;
  // Recent audit events for this actor (last 90 days, max 50). Filtered
  // to consent-relevant entities so the PDF stays focused.
  const since = new Date(Date.now() - 90 * 86_400_000);
  const events = await db.auditLog.findMany({
    where: {
      actorUserId: userId,
      createdAt: { gte: since },
      entity: { in: ['User', 'JemaahProfile', 'Consent'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, action: true, entity: true, createdAt: true,
      ip: true, userAgent: true, after: true,
    },
  });
  return {
    user, events,
    generatedAt: new Date(),
    controller: DATA_CONTROLLER,
    retention: RETENTION_NOTES,
  };
}

export async function streamConsentReceiptPdf(receipt, res) {
  if (!receipt) {
    res.status(404).end('Receipt not found');
    return;
  }
  const filename = `consent-receipt_${(receipt.user.email || receipt.user.id).replace(/[^a-z0-9._-]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(res);

  // Header
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1716').text('Bukti Persetujuan Pengolahan Data Pribadi', { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#666').text('Sesuai UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP)', { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor('#888').text(`Dihasilkan: ${receipt.generatedAt.toLocaleString('id-ID')}`, { align: 'center' });
  doc.moveDown(1.2);

  // Data subject
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1716').text('Identitas Subjek Data');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#1a1716');
  const u = receipt.user;
  doc.text(`Nama         : ${u.fullName || '—'}`);
  doc.text(`Email        : ${u.email || '—'}`);
  doc.text(`Telepon      : ${u.phone || u.jemaah?.phone || '—'}`);
  doc.text(`Akun dibuat  : ${new Date(u.createdAt).toLocaleString('id-ID')}`);
  doc.text(`Login terakhir: ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('id-ID') : '—'}`);
  doc.text(`Status akun  : ${u.status}`);
  doc.moveDown(0.8);

  // Data controller
  doc.font('Helvetica-Bold').fontSize(12).text('Pengendali Data (Data Controller)');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Nama         : ${receipt.controller.name}`);
  doc.text(`Email        : ${receipt.controller.email}`);
  doc.text(`Telepon      : ${receipt.controller.phone}`);
  doc.text(`Alamat       : ${receipt.controller.address}`);
  doc.moveDown(0.8);

  // Consent state
  doc.font('Helvetica-Bold').fontSize(12).text('Status Persetujuan Komunikasi');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  const p = u.jemaah;
  function consentLine(label, given, ts1, ts2) {
    const stamp = given && ts1 ? ` (sejak ${new Date(ts1).toLocaleDateString('id-ID')})`
      : !given && ts2 ? ` (ditarik ${new Date(ts2).toLocaleDateString('id-ID')})`
      : '';
    doc.text(`${label}: ${given ? '✓ DIBERIKAN' : '✗ DITOLAK'}${stamp}`);
  }
  if (p) {
    consentLine('WhatsApp transaksional', p.notifWa, p.notifWaConsentAt, p.notifWaWithdrawnAt);
    consentLine('Email transaksional', p.notifEmail, null, null);
    consentLine('Komunikasi marketing (ucapan ultah, re-engage)', p.notifEngagement, null, null);
  } else {
    doc.text('(Profil jemaah tidak ditemukan)');
  }
  doc.moveDown(0.8);

  // Retention policy
  doc.font('Helvetica-Bold').fontSize(12).text('Kebijakan Retensi Data');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  receipt.retention.forEach(([k, v]) => {
    doc.text(`${k}: ${v}`);
  });
  doc.moveDown(0.8);

  // Account events
  doc.font('Helvetica-Bold').fontSize(12).text('Riwayat Aktivitas Akun (90 hari terakhir)');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9);
  if (receipt.events.length === 0) {
    doc.text('(Tidak ada aktivitas tercatat dalam 90 hari terakhir.)');
  } else {
    receipt.events.slice(0, 30).forEach((e) => {
      const ts = new Date(e.createdAt).toLocaleString('id-ID');
      doc.text(`${ts} · ${e.action} ${e.entity}${e.ip ? ' · ' + e.ip : ''}`);
    });
    if (receipt.events.length > 30) {
      doc.text(`… dan ${receipt.events.length - 30} aktivitas lainnya`);
    }
  }
  doc.moveDown(0.8);

  // Rights
  doc.font('Helvetica-Bold').fontSize(12).text('Hak Subjek Data');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  doc.text('• Hak mengetahui data yang diolah → /saya/privasi');
  doc.text('• Hak mengubah/menambah data → /saya/profile');
  doc.text('• Hak menarik persetujuan komunikasi → /saya/profile (toggle notifikasi)');
  doc.text('• Hak portabilitas data (download ZIP semua data) → /saya/data-export.zip');
  doc.text('• Hak penghapusan akun → /saya/privasi (form permintaan)');
  doc.text(`• Hak mengajukan keluhan → ${receipt.controller.email}`);
  doc.moveDown(1);

  // Footer
  doc.fontSize(8).fillColor('#888').text(
    'Dokumen ini sah sebagai bukti persetujuan. Cetak/simpan untuk arsip pribadi Anda. ' +
    'Untuk pertanyaan: ' + receipt.controller.email,
    { align: 'center' },
  );

  doc.end();
}
