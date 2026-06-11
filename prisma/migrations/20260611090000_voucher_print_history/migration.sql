-- Stage 198 — voucher print history counters. Stamps each time
-- streamVoucherPdf is invoked so admin sees "voucher printed 3× last
-- by X on date Y" when jemaah calls customer service about a lost
-- voucher.
--
-- Two columns: count + lastAt timestamp. Avoid a full history table
-- (that would be a perpetual audit log; the count is enough signal
-- for the support workflow).
ALTER TABLE `Booking`
  ADD COLUMN `voucherPrintCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `lastVoucherPrintedAt` DATETIME(3) NULL,
  ADD COLUMN `lastVoucherPrintedByEmail` VARCHAR(190) NULL;
