-- Stage 150 — per-agent monthly komisi statement.
CREATE TABLE `KomisiStatement` (
  `id` VARCHAR(191) NOT NULL,
  `agentId` VARCHAR(191) NOT NULL,
  `periodYM` VARCHAR(7) NOT NULL,
  `totalEarnedIdr` DECIMAL(15,2) NOT NULL,
  `totalPaidIdr` DECIMAL(15,2) NOT NULL,
  `lineCount` INT NOT NULL,
  `pdfPath` VARCHAR(255) NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `KomisiStatement_agentId_periodYM_key`(`agentId`, `periodYM`),
  INDEX `KomisiStatement_periodYM_idx`(`periodYM`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `KomisiStatement` ADD CONSTRAINT `KomisiStatement_agentId_fkey`
  FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
