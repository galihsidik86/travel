-- Stage 144 — no-show detection on Booking.
ALTER TABLE `Booking` ADD COLUMN `noShowAt` DATETIME(3) NULL;
CREATE INDEX `Booking_noShowAt_idx` ON `Booking`(`noShowAt`);
