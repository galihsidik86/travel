-- S91: Task model + TaskStatus enum.
CREATE TABLE `Task` (
  `id` VARCHAR(191) NOT NULL,
  `bookingId` VARCHAR(191) NOT NULL,
  `assigneeEmail` VARCHAR(190) NOT NULL,
  `assigneeId` VARCHAR(191) NULL,
  `body` TEXT NOT NULL,
  `dueAt` DATETIME(3) NULL,
  `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
  `createdById` VARCHAR(191) NULL,
  `createdByEmail` VARCHAR(190) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `completedById` VARCHAR(191) NULL,
  `completedByEmail` VARCHAR(190) NULL,

  INDEX `Task_assigneeEmail_status_createdAt_idx`(`assigneeEmail`, `status`, `createdAt`),
  INDEX `Task_bookingId_status_idx`(`bookingId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Task`
  ADD CONSTRAINT `Task_bookingId_fkey`
  FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Task`
  ADD CONSTRAINT `Task_assigneeId_fkey`
  FOREIGN KEY (`assigneeId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Task`
  ADD CONSTRAINT `Task_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
