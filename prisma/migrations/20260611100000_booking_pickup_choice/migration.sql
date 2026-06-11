-- Stage 202 — booking-level pickup choice. FK to PaketPickup (S196).
-- Nullable so historical bookings stay valid; jemaah picks after
-- their booking is confirmed (typically post-LUNAS).
--
-- ON DELETE SET NULL — if admin deletes a pickup point, existing
-- choices fall back to "TBD" rather than cascading the booking away.
ALTER TABLE `Booking`
  ADD COLUMN `pickupId` VARCHAR(191) NULL,
  ADD CONSTRAINT `Booking_pickupId_fkey` FOREIGN KEY (`pickupId`) REFERENCES `PaketPickup`(`id`) ON DELETE SET NULL;
