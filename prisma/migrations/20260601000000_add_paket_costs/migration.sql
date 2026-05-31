-- Stage 22 — optional per-pax fully-loaded vendor cost on Paket.
ALTER TABLE `Paket`
  ADD COLUMN `costPerPaxIdr` DECIMAL(15, 2) NULL,
  ADD COLUMN `costNotes` TEXT NULL;
