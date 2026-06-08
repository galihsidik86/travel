-- S109: WebhookDelivery + WebhookDeliveryStatus.
CREATE TABLE `WebhookDelivery` (
  `id` VARCHAR(191) NOT NULL,
  `webhookId` VARCHAR(191) NOT NULL,
  `eventName` VARCHAR(80) NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `signature` VARCHAR(80) NOT NULL,
  `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `attemptCount` INT NOT NULL DEFAULT 0,
  `lastStatusCode` INT NULL,
  `lastError` TEXT NULL,
  `lastAttemptAt` DATETIME(3) NULL,
  `nextRetryAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `WebhookDelivery_status_nextRetryAt_idx`(`status`, `nextRetryAt`),
  INDEX `WebhookDelivery_webhookId_createdAt_idx`(`webhookId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WebhookDelivery`
  ADD CONSTRAINT `WebhookDelivery_webhookId_fkey`
  FOREIGN KEY (`webhookId`) REFERENCES `Webhook`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
