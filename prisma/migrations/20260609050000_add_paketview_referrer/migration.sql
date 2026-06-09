-- Stage 132 — referrer host attribution for visits without UTM tags.
ALTER TABLE `PaketView` ADD COLUMN `referrerHost` VARCHAR(120) NULL;
