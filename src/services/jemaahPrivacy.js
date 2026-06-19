// Stage 384 — Privacy dashboard for jemaah (UU PDP transparency).
//
// Consolidates everything UU PDP article 5 + 14-16 require:
//   - What data we hold about you
//   - What consents you've given (channels + scopes)
//   - Who else has access (agen + crew + admin tiers)
//   - Retention policy per data class
//   - Active links to exercise rights (download, delete, withdraw consent)
//
// Read-only aggregator — counts existing rows; no migrations, no writes.

import { db } from '../lib/db.js';

const RETENTION_TABLE = [
  { key: 'profile', label: 'Profil & identitas jemaah', window: 'Selama akun aktif', notes: 'Dihapus saat permintaan penghapusan disetujui' },
  { key: 'bookings', label: 'Booking & pembayaran', window: 'Permanen', notes: 'Kewajiban akuntansi (10 tahun min)' },
  { key: 'documents', label: 'File dokumen (paspor, visa)', window: 'Selama akun aktif', notes: 'Anda bisa hapus per-dokumen di /saya/profile' },
  { key: 'audit', label: 'Audit log aktivitas', window: '2 tahun aktif, lalu arsip terenkripsi', notes: 'Tidak bisa dihapus per UU akuntansi' },
  { key: 'notifs', label: 'Notifikasi yang sudah terkirim', window: '90 hari (SENT) / 180 hari (gagal)', notes: 'Auto-pruning mingguan' },
];

const ACCESS_TIERS = [
  { role: 'JEMAAH (Anda)', access: 'Semua data Anda — read + edit via /saya/profile' },
  { role: 'AGEN (yang Anda pilih)', access: 'Nama, telepon, paket, status booking — tidak melihat dokumen pribadi' },
  { role: 'MUTHAWWIF / Crew (di paket Anda)', access: 'Manifest: nama, telepon, paspor, kontak darurat, kamar — tidak melihat pembayaran' },
  { role: 'Admin: KASIR', access: 'Booking + pembayaran (untuk catat penerimaan uang)' },
  { role: 'Admin: OWNER/SUPERADMIN/MANAJER_OPS', access: 'Semua data operasional untuk menjalankan paket' },
  { role: 'Pihak ketiga (Midtrans payment gateway)', access: 'Hanya saat Anda bayar online — kami terima order ID + jumlah, mereka simpan info kartu/VA' },
];

export async function getJemaahPrivacyDashboard(userId) {
  if (!userId) return { user: null };
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, fullName: true, phone: true,
      role: true, createdAt: true, lastLoginAt: true, status: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true, email: true,
          nik: true, passportNo: true, birthDate: true, address: true,
          emergencyContact: true,
          notifEmail: true, notifWa: true, notifEngagement: true,
          notifWaConsentAt: true, notifWaWithdrawnAt: true,
        },
      },
    },
  });
  if (!user || !user.jemaah) return { user: null };

  // Counts of what we hold
  const [bookingCount, docCount, notifCount, deletionRequests] = await Promise.all([
    db.booking.count({
      where: { OR: [{ jemaahUserId: userId }, { jemaahId: user.jemaah.id }] },
    }),
    db.jemaahDocument.count({ where: { jemaahId: user.jemaah.id } }),
    db.notification.count({ where: { recipientUserId: userId } }),
    db.dataDeletionRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take: 3,
      select: { id: true, status: true, requestedAt: true, decidedAt: true, requestReason: true, decisionReason: true },
    }),
  ]);

  return {
    user,
    profile: user.jemaah,
    dataHeld: { bookingCount, docCount, notifCount },
    retention: RETENTION_TABLE,
    accessTiers: ACCESS_TIERS,
    deletionRequests,
    generatedAt: new Date(),
  };
}
