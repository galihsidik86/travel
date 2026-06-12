-- Stage 220 — per-pickup driver contact. Bus drivers download the S208
-- pickup roster CSV; jemaah sees who to call at the curb on
-- /saya/bookings/:id. All nullable (back-compat for existing rows + admin
-- might not know the driver yet at creation time).
ALTER TABLE `PaketPickup`
  ADD COLUMN `driverName`  VARCHAR(120) NULL,
  ADD COLUMN `driverPhone` VARCHAR(30)  NULL,
  ADD COLUMN `plateNumber` VARCHAR(20)  NULL;
