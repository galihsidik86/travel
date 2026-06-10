-- Stage 166 — agent payout banking details. Self-service by the
-- agent at /agen/profile; consumed by KASIR at /admin/payouts/new
-- so they don't have to ask the agent every payout cycle.
-- All fields nullable — pre-S166 agents stay valid.
ALTER TABLE `AgentProfile`
  ADD COLUMN `preferredPayoutMethod` ENUM('TRANSFER','CASH','EWALLET','QRIS') NULL,
  ADD COLUMN `bankName` VARCHAR(80) NULL,
  ADD COLUMN `bankAccountNumber` VARCHAR(40) NULL,
  ADD COLUMN `bankAccountName` VARCHAR(100) NULL;
