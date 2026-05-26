-- AlterTable
ALTER TABLE `notification` ADD COLUMN `readAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Notification_recipientUserId_readAt_idx` ON `Notification`(`recipientUserId`, `readAt`);
