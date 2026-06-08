-- Stage 61: ads spend on paket for ROI calculation
ALTER TABLE `paket`
  ADD COLUMN `adsSpendIdr` DECIMAL(15, 2) NULL,
  ADD COLUMN `adsNotes` TEXT NULL;

-- Stage 63: Testimonial CRUD
CREATE TABLE `Testimonial` (
  `id` VARCHAR(191) NOT NULL,
  `paketId` VARCHAR(191) NULL,
  `jemaahName` VARCHAR(120) NOT NULL,
  `jemaahCity` VARCHAR(120) NULL,
  `body` TEXT NOT NULL,
  `rating` INT NOT NULL DEFAULT 5,
  `photoUrl` VARCHAR(255) NULL,
  `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  `sortOrder` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `Testimonial_status_sortOrder_idx`(`status`, `sortOrder`),
  INDEX `Testimonial_paketId_idx`(`paketId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Testimonial` ADD CONSTRAINT `Testimonial_paketId_fkey`
  FOREIGN KEY (`paketId`) REFERENCES `paket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
