-- CreateTable
CREATE TABLE `PaketCrew` (
    `paketId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaketCrew_userId_idx`(`userId`),
    INDEX `PaketCrew_paketId_idx`(`paketId`),
    PRIMARY KEY (`paketId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaketCrew` ADD CONSTRAINT `PaketCrew_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaketCrew` ADD CONSTRAINT `PaketCrew_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
