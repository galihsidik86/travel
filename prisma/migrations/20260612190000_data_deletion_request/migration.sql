-- Stage 240 — jemaah-submitted right-to-be-forgotten request. Admin reviews
-- and either acts (via existing /admin/users delete flow) or declines.
-- Status state machine: PENDING → APPROVED | DECLINED. Terminal states
-- include who decided + when + reason.
CREATE TABLE `DataDeletionRequest` (
  `id`             VARCHAR(40)  NOT NULL,
  `userId`         VARCHAR(40)  NOT NULL,
  `requestedAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `requestReason`  TEXT         NOT NULL,
  `status`         ENUM('PENDING','APPROVED','DECLINED') NOT NULL DEFAULT 'PENDING',
  `decidedAt`      DATETIME(3)  NULL,
  `decidedById`    VARCHAR(40)  NULL,
  `decidedByEmail` VARCHAR(190) NULL,
  `decisionReason` TEXT         NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `DataDeletionRequest_userId_idx` (`userId`),
  KEY `DataDeletionRequest_status_idx` (`status`),
  CONSTRAINT `DataDeletionRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `DataDeletionRequest_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
