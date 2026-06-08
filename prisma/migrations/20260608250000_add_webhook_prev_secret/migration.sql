-- S118: webhook secret rotation overlap.
ALTER TABLE `Webhook`
  ADD COLUMN `prevSecret` VARCHAR(120) NULL,
  ADD COLUMN `prevSecretExpiresAt` DATETIME(3) NULL;
