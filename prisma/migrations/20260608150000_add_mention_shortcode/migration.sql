-- S88: MentionShortcode table for :code → @user.email expansion.
CREATE TABLE `MentionShortcode` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(40) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById` VARCHAR(191) NULL,

  UNIQUE INDEX `MentionShortcode_code_key`(`code`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MentionShortcode`
  ADD CONSTRAINT `MentionShortcode_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MentionShortcode`
  ADD CONSTRAINT `MentionShortcode_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
