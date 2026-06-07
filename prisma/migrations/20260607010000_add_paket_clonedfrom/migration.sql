-- AlterTable
ALTER TABLE `paket` ADD COLUMN `clonedFromId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Paket_clonedFromId_idx` ON `paket`(`clonedFromId`);

-- AddForeignKey
ALTER TABLE `paket` ADD CONSTRAINT `Paket_clonedFromId_fkey` FOREIGN KEY (`clonedFromId`) REFERENCES `paket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
