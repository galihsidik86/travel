-- CreateTable
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('BOOKING_CREATED', 'PAYMENT_RECEIVED', 'BOOKING_LUNAS', 'PAYOUT_CREATED', 'DOC_VERIFIED', 'GENERIC') NOT NULL,
    `channel` ENUM('EMAIL', 'WA', 'CONSOLE') NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `recipientEmail` VARCHAR(191) NULL,
    `recipientPhone` VARCHAR(191) NULL,
    `subject` TEXT NULL,
    `body` TEXT NOT NULL,
    `payload` JSON NULL,
    `relatedEntity` VARCHAR(191) NULL,
    `relatedEntityId` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Notification_status_idx`(`status`),
    INDEX `Notification_type_idx`(`type`),
    INDEX `Notification_channel_idx`(`channel`),
    INDEX `Notification_relatedEntity_relatedEntityId_idx`(`relatedEntity`, `relatedEntityId`),
    INDEX `Notification_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
