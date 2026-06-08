-- S108: Webhook subscriptions + status enum.
CREATE TABLE `Webhook` (
  `id` VARCHAR(191) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `secret` VARCHAR(120) NOT NULL,
  `events` JSON NOT NULL,
  `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  `description` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById` VARCHAR(191) NULL,
  `lastFiredAt` DATETIME(3) NULL,
  `lastStatus` INT NULL,
  `lastError` TEXT NULL,
  `lastEventName` VARCHAR(80) NULL,

  INDEX `Webhook_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Webhook`
  ADD CONSTRAINT `Webhook_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
