-- CreateTable
CREATE TABLE `Incident` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `type` ENUM('SOS', 'MEDICAL', 'LOST_JEMAAH', 'SECURITY', 'LOGISTICAL', 'OTHER') NOT NULL,
    `message` TEXT NULL,
    `locationLabel` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'ACKED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `ackedById` VARCHAR(191) NULL,
    `ackedAt` DATETIME(3) NULL,
    `resolvedById` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolution` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Incident_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Incident_createdById_createdAt_idx`(`createdById`, `createdAt`),
    INDEX `Incident_paketId_createdAt_idx`(`paketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Incident` ADD CONSTRAINT `Incident_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Incident` ADD CONSTRAINT `Incident_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Incident` ADD CONSTRAINT `Incident_ackedById_fkey` FOREIGN KEY (`ackedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Incident` ADD CONSTRAINT `Incident_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
