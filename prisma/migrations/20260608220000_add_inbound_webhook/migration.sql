-- S111: InboundWebhook receiver + status enum.
CREATE TABLE `InboundWebhook` (
  `id` VARCHAR(191) NOT NULL,
  `source` VARCHAR(80) NOT NULL,
  `headers` JSON NOT NULL,
  `payload` LONGTEXT NOT NULL,
  `signatureValid` BOOLEAN NULL,
  `status` ENUM('RECEIVED', 'REJECTED', 'HANDLED', 'HANDLER_ERROR') NOT NULL DEFAULT 'RECEIVED',
  `handlerError` TEXT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `InboundWebhook_source_receivedAt_idx`(`source`, `receivedAt`),
  INDEX `InboundWebhook_status_receivedAt_idx`(`status`, `receivedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
