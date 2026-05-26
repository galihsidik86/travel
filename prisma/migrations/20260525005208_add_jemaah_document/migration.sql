-- CreateTable
CREATE TABLE `JemaahDocument` (
    `id` VARCHAR(191) NOT NULL,
    `jemaahId` VARCHAR(191) NOT NULL,
    `type` ENUM('PASSPORT', 'VISA_UMROH', 'MANASIK_CERT', 'HEALTH_CERT', 'VACCINE_MENINGITIS', 'MARRIAGE_CERT', 'FAMILY_CARD', 'OTHER') NOT NULL,
    `status` ENUM('PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `refNumber` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `submittedAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `verifiedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JemaahDocument_jemaahId_idx`(`jemaahId`),
    INDEX `JemaahDocument_status_idx`(`status`),
    INDEX `JemaahDocument_type_idx`(`type`),
    UNIQUE INDEX `JemaahDocument_jemaahId_type_key`(`jemaahId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JemaahDocument` ADD CONSTRAINT `JemaahDocument_jemaahId_fkey` FOREIGN KEY (`jemaahId`) REFERENCES `JemaahProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JemaahDocument` ADD CONSTRAINT `JemaahDocument_verifiedById_fkey` FOREIGN KEY (`verifiedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
