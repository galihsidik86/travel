-- Stage 344 — reschedule reason categorization on Booking.
ALTER TABLE `Booking`
  ADD COLUMN `rescheduleReasonCode` ENUM(
    'JEMAAH_REQUEST', 'DOCUMENT_DELAY', 'HEALTH', 'FINANCIAL',
    'PAKET_FULL', 'SCHEDULE_CONFLICT', 'OPERATOR_INITIATED', 'OTHER'
  ) NULL;

CREATE INDEX `Booking_rescheduleReasonCode_idx` ON `Booking` (`rescheduleReasonCode`);
