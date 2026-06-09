-- Stage 133 — referrer host snapshot on Booking (mirrors S132 on PaketView).
ALTER TABLE `Booking` ADD COLUMN `referrerHost` VARCHAR(120) NULL;
