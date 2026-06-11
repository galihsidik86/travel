-- Stage 190 — per-paket FAQ. Admin curates common questions per paket;
-- renders as collapsible accordion below the hero on /p/:slug so
-- jemaah can self-serve before booking.
--
-- Sort order admin-controlled (small int 0..9999), default 0. Question
-- capped at 200 chars (longer questions break the accordion summary
-- layout); answer Text for long-form responses.
CREATE TABLE `PaketFaq` (
  `id`        VARCHAR(191) NOT NULL,
  `paketId`   VARCHAR(191) NOT NULL,
  `question`  VARCHAR(200) NOT NULL,
  `answer`    TEXT         NOT NULL,
  `sortOrder` INT          NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `PaketFaq_paketId_idx` (`paketId`),
  CONSTRAINT `PaketFaq_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE
);
