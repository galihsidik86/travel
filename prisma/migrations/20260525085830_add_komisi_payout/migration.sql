-- AlterTable
ALTER TABLE `komisi` ADD COLUMN `payoutId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `KomisiPayout` (
    `id` VARCHAR(191) NOT NULL,
    `payoutNo` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` ENUM('IDR', 'USD', 'SAR') NOT NULL DEFAULT 'IDR',
    `method` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `paidById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `KomisiPayout_payoutNo_key`(`payoutNo`),
    INDEX `KomisiPayout_agentId_idx`(`agentId`),
    INDEX `KomisiPayout_paidAt_idx`(`paidAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Komisi_payoutId_idx` ON `Komisi`(`payoutId`);

-- AddForeignKey
ALTER TABLE `Komisi` ADD CONSTRAINT `Komisi_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `KomisiPayout`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KomisiPayout` ADD CONSTRAINT `KomisiPayout_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KomisiPayout` ADD CONSTRAINT `KomisiPayout_paidById_fkey` FOREIGN KEY (`paidById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
