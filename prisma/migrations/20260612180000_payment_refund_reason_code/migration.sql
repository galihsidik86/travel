-- Stage 235 — structured refund reason code on the negative-amount
-- Payment row (the refund). Free-text `notes` still carries the
-- humanised explanation; this is the categorical drop-down so refund
-- analytics (S35) can aggregate per category. Validated service-side
-- against an allowlist (not a DB enum — flexible to add codes later).
-- NULL = unset (back-compat for pre-S235 refund rows).
ALTER TABLE `Payment`
  ADD COLUMN `refundReasonCode` VARCHAR(40) NULL,
  ADD INDEX `Payment_refundReasonCode_idx` (`refundReasonCode`);
