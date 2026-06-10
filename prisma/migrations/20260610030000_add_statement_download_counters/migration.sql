-- Stage 162 — per-surface download counters on KomisiStatement.
ALTER TABLE `KomisiStatement`
  ADD COLUMN `agentDownloadCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `agentLastDownloadAt` DATETIME(3) NULL,
  ADD COLUMN `adminDownloadCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `adminLastDownloadAt` DATETIME(3) NULL;
