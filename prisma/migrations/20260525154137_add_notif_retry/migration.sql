-- AlterTable
ALTER TABLE `notification` ADD COLUMN `attemptCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `nextRetryAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Notification_status_nextRetryAt_idx` ON `Notification`(`status`, `nextRetryAt`);
