-- Stage 232-234 — auto-tag idempotency tracker. JSON array of auto-tag
-- codes that have ALREADY been computed-and-applied for this booking.
-- Used by the autopilot to honour admin's manual removal: if admin removes
-- an auto-tag, the next pass sees it in `autoTaggedSeen` but missing from
-- `tags` and won't re-add. NULL = never auto-tagged (back-compat default).
ALTER TABLE `Booking`
  ADD COLUMN `autoTaggedSeen` JSON NULL;
