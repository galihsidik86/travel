-- Stage 179 — single-row shared note for admin team. Editable by 4
-- admin roles (OWNER/SUPERADMIN/MANAJER_OPS/KASIR), visible to all
-- admin sessions on /admin overview.
--
-- Pattern: classic single-row config table with `id='singleton'`
-- so we never need a row-id from the caller — just upsert on the
-- known PK.
CREATE TABLE `AdminTeamNote` (
  `id` VARCHAR(20) NOT NULL DEFAULT 'singleton',
  `body` TEXT NULL,
  `updatedById` VARCHAR(191) NULL,
  `updatedByEmail` VARCHAR(190) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
);
