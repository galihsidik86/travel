-- Stage 134 — end-to-end attempt latency in ms (captured by attemptDelivery).
ALTER TABLE `WebhookDelivery` ADD COLUMN `durationMs` INT NULL;
