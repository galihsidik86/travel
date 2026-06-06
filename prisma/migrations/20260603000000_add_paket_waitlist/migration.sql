-- Stage 26 — paket waitlist.
CREATE TABLE `PaketWaitlist` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `status` ENUM('WAITING', 'PROMOTED', 'CANCELLED') NOT NULL DEFAULT 'WAITING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `promotedAt` DATETIME(3) NULL,
    `promotedBookingId` VARCHAR(191) NULL,
    `cancelledAt` DATETIME(3) NULL,
    INDEX `PaketWaitlist_paketId_status_idx`(`paketId`, `status`),
    INDEX `PaketWaitlist_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `PaketWaitlist_paketId_phone_key`(`paketId`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PaketWaitlist` ADD CONSTRAINT `PaketWaitlist_paketId_fkey`
  FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
