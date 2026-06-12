-- Stage 226 — booking tags. JSON array of short uppercase labels
-- (VIP / LANSIA / HONEYMOON / etc.) for fast manifest filtering. Admin
-- curates per booking from /admin/bookings/:id. NULL = no tags (back-compat).
ALTER TABLE `Booking`
  ADD COLUMN `tags` JSON NULL;
