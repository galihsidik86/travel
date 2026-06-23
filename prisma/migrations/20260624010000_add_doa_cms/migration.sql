-- Stage 389 — Doa CMS

CREATE TABLE `Doa` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `arabic` TEXT NULL,
  `latin` TEXT NULL,
  `translation` TEXT NULL,
  `audioPath` VARCHAR(191) NULL,
  `audioUrl` VARCHAR(500) NULL,
  `videoUrl` VARCHAR(500) NULL,
  `category` VARCHAR(60) NULL,
  `credit` VARCHAR(255) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `createdById` VARCHAR(191) NULL,

  INDEX `Doa_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
  INDEX `Doa_category_isActive_idx`(`category`, `isActive`),
  INDEX `Doa_createdById_fkey`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Doa` ADD CONSTRAINT `Doa_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
