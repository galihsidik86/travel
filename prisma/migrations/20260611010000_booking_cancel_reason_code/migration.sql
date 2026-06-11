-- Stage 175 — structured cancel reason category alongside the
-- free-text cancelReason. Admin picks one when cancelling; lets
-- analytics answer "why do bookings cancel?" without text parsing.
-- Nullable so historical cancels (pre-S175) stay valid.
ALTER TABLE `Booking`
  ADD COLUMN `cancelReasonCode` ENUM(
    'JEMAAH_REQUEST',     -- jemaah pulled out (most common)
    'PAKET_CANCELLED',    -- whole trip cancelled by operator
    'PAYMENT_NOT_RECEIVED', -- jemaah never paid; admin closed
    'DOCUMENT_INCOMPLETE', -- jemaah couldn't complete docs
    'NO_SHOW',            -- jemaah didn't show on departure day
    'GOODWILL',           -- operator-side goodwill cancellation
    'OTHER'               -- fallback when none fit
  ) NULL;

CREATE INDEX `Booking_cancelReasonCode_idx` ON `Booking`(`cancelReasonCode`);
