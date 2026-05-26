-- AlterTable
ALTER TABLE `jemaahdocument` ADD COLUMN `fileName` VARCHAR(191) NULL,
    ADD COLUMN `filePath` VARCHAR(191) NULL,
    ADD COLUMN `fileSize` INTEGER NULL,
    ADD COLUMN `fileUploadedAt` DATETIME(3) NULL,
    ADD COLUMN `mimeType` VARCHAR(191) NULL;
