-- S121/S122: per-request log for partner API calls.
CREATE TABLE `ApiRequestLog` (
  `id` VARCHAR(191) NOT NULL,
  `apiKeyId` VARCHAR(191) NULL,
  `path` VARCHAR(255) NOT NULL,
  `method` VARCHAR(10) NOT NULL,
  `statusCode` INT NOT NULL,
  `durationMs` INT NOT NULL,
  `scope` VARCHAR(40) NULL,
  `ip` VARCHAR(45) NULL,
  `ts` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ApiRequestLog_apiKeyId_ts_idx`(`apiKeyId`, `ts`),
  INDEX `ApiRequestLog_ts_idx`(`ts`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ApiRequestLog`
  ADD CONSTRAINT `ApiRequestLog_apiKeyId_fkey`
  FOREIGN KEY (`apiKeyId`) REFERENCES `ApiKey`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
