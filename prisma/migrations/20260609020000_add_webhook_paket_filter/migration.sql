-- Stage 128 — optional per-paket subscription filter on Webhook.
-- NULL = subscribe across every paket (legacy default). When set,
-- dispatchEvent only delivers events whose payload.paketId matches.
ALTER TABLE `Webhook` ADD COLUMN `paketId` VARCHAR(191) NULL;

CREATE INDEX `Webhook_paketId_idx` ON `Webhook`(`paketId`);

ALTER TABLE `Webhook` ADD CONSTRAINT `Webhook_paketId_fkey`
  FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
