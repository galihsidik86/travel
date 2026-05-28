-- CreateTable
CREATE TABLE `JemaahNotifPref` (
    `jemaahId` VARCHAR(191) NOT NULL,
    `type` ENUM('BOOKING_CREATED', 'PAYMENT_RECEIVED', 'BOOKING_LUNAS', 'REFUND_ISSUED', 'CANCEL_REQUESTED', 'PAYMENT_SETTLED_ADMIN', 'PAYOUT_CREATED', 'DOC_VERIFIED', 'GENERIC') NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JemaahNotifPref_jemaahId_idx`(`jemaahId`),
    PRIMARY KEY (`jemaahId`, `type`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JemaahNotifPref` ADD CONSTRAINT `JemaahNotifPref_jemaahId_fkey` FOREIGN KEY (`jemaahId`) REFERENCES `JemaahProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
