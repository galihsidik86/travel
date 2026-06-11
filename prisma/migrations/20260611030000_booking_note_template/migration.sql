-- Stage 180 — reusable note templates for the booking notes textarea.
-- Admin maintains a small list of common phrases (lansia, mahram,
-- diet khusus, dll); quick-insert dropdown above the textarea.
CREATE TABLE `BookingNoteTemplate` (
  `id`        VARCHAR(191) NOT NULL,
  `name`      VARCHAR(80)  NOT NULL,
  `body`      TEXT         NOT NULL,
  `sortOrder` INT          NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `BookingNoteTemplate_name_key` (`name`)
);
