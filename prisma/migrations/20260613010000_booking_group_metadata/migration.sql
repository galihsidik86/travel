-- Stage 260 — group-level metadata for Booking.groupKey clusters.
-- Standalone table keyed on groupKey; no FK back to Booking (groupKey
-- isn't unique on Booking — every member shares it). label/notes
-- are admin-curated; the rest of the schema doesn't change.
CREATE TABLE `BookingGroup` (
  `groupKey` VARCHAR(40) NOT NULL,
  `label` VARCHAR(120) NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`groupKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
