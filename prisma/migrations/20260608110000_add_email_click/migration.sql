-- Stage 77: email click tracking
CREATE TABLE `EmailClick` (
  `id` VARCHAR(191) NOT NULL,
  `notificationId` VARCHAR(191) NOT NULL,
  `targetUrl` VARCHAR(500) NOT NULL,
  `ipAddress` VARCHAR(45) NULL,
  `userAgent` VARCHAR(255) NULL,
  `firstClickAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastClickAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `clickCount` INT NOT NULL DEFAULT 1,

  UNIQUE INDEX `EmailClick_notificationId_targetUrl_key`(`notificationId`, `targetUrl`),
  INDEX `EmailClick_notificationId_idx`(`notificationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `EmailClick` ADD CONSTRAINT `EmailClick_notificationId_fkey`
  FOREIGN KEY (`notificationId`) REFERENCES `Notification`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
