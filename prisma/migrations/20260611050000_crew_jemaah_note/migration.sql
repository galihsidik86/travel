-- Stage 187 — crew per-jemaah notes. Crew adds private notes per
-- (paket, jemaah) on the manifest — e.g. "lansia perlu pendamping",
-- "alergi laut". Read-only for admin.
--
-- Composite unique on (paketId, jemaahId, crewUserId) so each crew
-- has at most one note per jemaah per paket (re-saves upsert in
-- place rather than stacking rows). Two different muthawwif on
-- the same paket can each leave their own note.
CREATE TABLE `CrewJemaahNote` (
  `id`          VARCHAR(191) NOT NULL,
  `paketId`     VARCHAR(191) NOT NULL,
  `jemaahId`    VARCHAR(191) NOT NULL,
  `crewUserId`  VARCHAR(191) NOT NULL,
  `body`        TEXT         NOT NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `CrewJemaahNote_triple_key` (`paketId`, `jemaahId`, `crewUserId`),
  INDEX `CrewJemaahNote_paket_jemaah_idx` (`paketId`, `jemaahId`),
  CONSTRAINT `CrewJemaahNote_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE,
  CONSTRAINT `CrewJemaahNote_jemaahId_fkey` FOREIGN KEY (`jemaahId`) REFERENCES `JemaahProfile`(`id`) ON DELETE CASCADE,
  CONSTRAINT `CrewJemaahNote_crewUserId_fkey` FOREIGN KEY (`crewUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE
);
