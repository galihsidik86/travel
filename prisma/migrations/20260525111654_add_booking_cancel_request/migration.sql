-- AlterTable
ALTER TABLE `booking` ADD COLUMN `cancelRequestReason` TEXT NULL,
    ADD COLUMN `cancelRequested` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `cancelRequestedAt` DATETIME(3) NULL;
