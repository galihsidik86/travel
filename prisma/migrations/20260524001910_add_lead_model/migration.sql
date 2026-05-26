-- CreateTable
CREATE TABLE `Lead` (
    `id` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `source` ENUM('WA', 'IG', 'FB', 'TIKTOK', 'WALK_IN', 'REFERRAL', 'AD', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `status` ENUM('COLD', 'WARM', 'CONVERTED', 'LOST') NOT NULL DEFAULT 'COLD',
    `interestedPaketSlug` VARCHAR(191) NULL,
    `interestedKelas` ENUM('QUAD', 'TRIPLE', 'DOUBLE', 'VVIP') NULL,
    `estPaxCount` INTEGER NULL,
    `estValueIdr` DECIMAL(15, 2) NULL,
    `score` INTEGER NULL,
    `followUpAt` DATETIME(3) NULL,
    `convertedAt` DATETIME(3) NULL,
    `convertedBookingId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Lead_convertedBookingId_key`(`convertedBookingId`),
    INDEX `Lead_agentId_status_idx`(`agentId`, `status`),
    INDEX `Lead_followUpAt_idx`(`followUpAt`),
    INDEX `Lead_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
