-- Stage 373: photo evidence on incident
ALTER TABLE `Incident`
  ADD COLUMN `photoPath`       VARCHAR(500) NULL,
  ADD COLUMN `photoName`       VARCHAR(255) NULL,
  ADD COLUMN `photoSize`       INT          NULL,
  ADD COLUMN `photoMime`       VARCHAR(100) NULL,
  ADD COLUMN `photoUploadedAt` DATETIME(3)  NULL;

-- Stage 374: per-paket vendor / hotel / emergency contact book
CREATE TABLE `CrewVendorContact` (
  `id`        VARCHAR(191) NOT NULL,
  `paketId`   VARCHAR(191) NOT NULL,
  `category`  ENUM('HOTEL','BUS','AMBULANCE','CLINIC','EMBASSY','RESTAURANT','GUIDE','OTHER') NOT NULL,
  `label`     VARCHAR(120) NOT NULL,
  `phone`     VARCHAR(30)  NULL,
  `whatsapp`  VARCHAR(30)  NULL,
  `address`   VARCHAR(500) NULL,
  `notes`     TEXT NULL,
  `sortOrder` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `CrewVendorContact_paketId_category_idx` (`paketId`, `category`),
  CONSTRAINT `CrewVendorContact_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
