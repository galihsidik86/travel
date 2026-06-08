-- CreateTable
CREATE TABLE `PaketView` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `visitorId` VARCHAR(191) NOT NULL,
    `dayKey` VARCHAR(191) NOT NULL,
    `agentSlug` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PaketView_paketId_visitorId_dayKey_key`(`paketId`, `visitorId`, `dayKey`),
    INDEX `PaketView_paketId_createdAt_idx`(`paketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaketView` ADD CONSTRAINT `PaketView_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
