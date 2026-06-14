-- Stage 295 — per-booking adjustment (discount/surcharge).
CREATE TABLE `BookingAdjustment` (
  `id`             VARCHAR(191) NOT NULL,
  `bookingId`      VARCHAR(191) NOT NULL,
  `kind`           ENUM('DISCOUNT','SURCHARGE') NOT NULL,
  `amountIdr`      DECIMAL(15, 2) NOT NULL,
  `reasonCode`     VARCHAR(40) NOT NULL,
  `reasonNote`     TEXT NULL,
  `createdAt`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdByEmail` VARCHAR(190) NULL,
  PRIMARY KEY (`id`),
  KEY `BookingAdjustment_bookingId_idx` (`bookingId`),
  KEY `BookingAdjustment_reasonCode_createdAt_idx` (`reasonCode`, `createdAt`),
  CONSTRAINT `BookingAdjustment_bookingId_fkey`
    FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
