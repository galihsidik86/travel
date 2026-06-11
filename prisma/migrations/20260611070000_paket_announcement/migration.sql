-- Stage 192 — per-paket announcement banner. Admin posts a banner;
-- renders on /saya/bookings/:id for jemaah on this paket. Optional
-- publishedAt (defaults now) and expiresAt for scheduled visibility.
--
-- Multiple announcements per paket allowed (admin might pin both
-- "Manasik tgl X" + "Bayar pelunasan H-30"). View shows all active
-- ones; jemaah dashboard surfaces the most recent active one as a
-- nudge badge.
CREATE TABLE `PaketAnnouncement` (
  `id`          VARCHAR(191) NOT NULL,
  `paketId`     VARCHAR(191) NOT NULL,
  `title`       VARCHAR(200) NOT NULL,
  `body`        TEXT         NOT NULL,
  `publishedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt`   DATETIME(3)  NULL,
  `authorId`    VARCHAR(191) NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `PaketAnnouncement_paket_active_idx` (`paketId`, `publishedAt`, `expiresAt`),
  CONSTRAINT `PaketAnnouncement_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE,
  CONSTRAINT `PaketAnnouncement_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE SET NULL
);
