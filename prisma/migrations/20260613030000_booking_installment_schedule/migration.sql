-- Stage 268 — per-booking installment schedule. JSON array of
-- {id, dueDate, amountIdr, status: PENDING|PAID, paidAt?}.
-- Nullable: back-compat with pre-S268 bookings (lump-sum).
ALTER TABLE `Booking`
  ADD COLUMN `installmentSchedule` JSON NULL;
