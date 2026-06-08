-- S92: PaketCostLine + CostCategory.
CREATE TABLE `PaketCostLine` (
  `id` VARCHAR(191) NOT NULL,
  `paketId` VARCHAR(191) NOT NULL,
  `category` ENUM('HOTEL', 'FLIGHT', 'VISA', 'MEALS', 'GROUND_OPS', 'GUIDE', 'INSURANCE', 'OTHER') NOT NULL,
  `amountIdr` DECIMAL(15, 2) NOT NULL,
  `vendorNote` TEXT NULL,
  `sortOrder` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `PaketCostLine_paketId_sortOrder_idx`(`paketId`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PaketCostLine`
  ADD CONSTRAINT `PaketCostLine_paketId_fkey`
  FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
