-- Stage 206 — pin/unpin booking notes. When notesPinned=true, the
-- note shows as a gold banner at the top of /admin/bookings/:id so
-- urgent context isn't buried (e.g. "VIP — handle personally" or
-- "warning: prior dispute, careful with refunds").
ALTER TABLE `Booking`
  ADD COLUMN `notesPinned` BOOLEAN NOT NULL DEFAULT FALSE;
