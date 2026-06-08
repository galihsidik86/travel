-- S86: BookingMention table — one row per (booking, user) per new mention.
CREATE TABLE `BookingMention` (
  `id` VARCHAR(191) NOT NULL,
  `bookingId` VARCHAR(191) NOT NULL,
  `userEmail` VARCHAR(190) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `mentionedById` VARCHAR(191) NULL,
  `mentionedByEmail` VARCHAR(190) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `BookingMention_userEmail_createdAt_idx`(`userEmail`, `createdAt`),
  INDEX `BookingMention_bookingId_createdAt_idx`(`bookingId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BookingMention`
  ADD CONSTRAINT `BookingMention_bookingId_fkey`
  FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BookingMention`
  ADD CONSTRAINT `BookingMention_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `BookingMention`
  ADD CONSTRAINT `BookingMention_mentionedById_fkey`
  FOREIGN KEY (`mentionedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
