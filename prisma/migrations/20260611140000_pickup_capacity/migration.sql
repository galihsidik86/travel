-- Stage 212 — per-pickup capacity cap. Admin sets max seats per bus;
-- jemaah self-pick refuses with PICKUP_FULL 409 when at the cap.
-- NULL = no cap (back-compat default). Cap is total paxCount across
-- non-CANCELLED/REFUNDED bookings on the pickup, not row count.
ALTER TABLE `PaketPickup`
  ADD COLUMN `maxCapacity` INT NULL;
