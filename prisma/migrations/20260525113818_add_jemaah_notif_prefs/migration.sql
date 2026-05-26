-- AlterTable
ALTER TABLE `jemaahprofile` ADD COLUMN `notifEmail` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `notifWa` BOOLEAN NOT NULL DEFAULT true;
