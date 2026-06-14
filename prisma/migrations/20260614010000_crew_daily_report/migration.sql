-- Stage 277 — crew daily reports. One row per (paket, crew, reportDate).
-- Mood traffic-light surfaces trip health to admin at a glance.

CREATE TABLE `CrewDailyReport` (
  `id`         VARCHAR(191) NOT NULL,
  `paketId`    VARCHAR(191) NOT NULL,
  `crewUserId` VARCHAR(191) NOT NULL,
  `reportDate` DATE         NOT NULL,
  `dayNumber`  INT          NULL,
  `mood`       ENUM('GREEN','AMBER','RED') NOT NULL DEFAULT 'GREEN',
  `body`       TEXT         NOT NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `CrewDailyReport_paketId_crewUserId_reportDate_key`
    (`paketId`, `crewUserId`, `reportDate`),
  KEY `CrewDailyReport_paketId_reportDate_idx` (`paketId`, `reportDate`),
  KEY `CrewDailyReport_crewUserId_reportDate_idx` (`crewUserId`, `reportDate`),

  CONSTRAINT `CrewDailyReport_paketId_fkey`
    FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE,
  CONSTRAINT `CrewDailyReport_crewUserId_fkey`
    FOREIGN KEY (`crewUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
