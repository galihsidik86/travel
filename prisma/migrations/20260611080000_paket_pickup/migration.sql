-- Stage 196 — per-paket pickup points. Multiple bus pickup locations
-- per paket (Bekasi/Bogor/Tangerang/etc.). Admin curates; jemaah picks
-- one when claiming the booking detail page.
--
-- `departTime` is a local TIME (HH:MM, no date) — same time each pickup
-- run. Booking-level pickup choice deferred (S198) to keep this stage
-- focused.
CREATE TABLE `PaketPickup` (
  `id`          VARCHAR(191) NOT NULL,
  `paketId`     VARCHAR(191) NOT NULL,
  `label`       VARCHAR(80)  NOT NULL,
  `address`     VARCHAR(500) NOT NULL,
  `departTime`  VARCHAR(5)   NULL,
  `notes`       TEXT         NULL,
  `sortOrder`   INT          NOT NULL DEFAULT 0,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `PaketPickup_paketId_idx` (`paketId`),
  CONSTRAINT `PaketPickup_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE
);
