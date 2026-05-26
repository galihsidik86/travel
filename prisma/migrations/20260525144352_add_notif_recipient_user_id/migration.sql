-- AlterTable
ALTER TABLE `notification` ADD COLUMN `recipientUserId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Notification_recipientUserId_createdAt_idx` ON `Notification`(`recipientUserId`, `createdAt`);
