-- Stage 131 — per-subscription burst rate-limit (requests/minute).
-- Default 30 is conservative; admin can crank up via /admin/webhooks edit.
ALTER TABLE `Webhook` ADD COLUMN `rateLimitPerMin` INT NOT NULL DEFAULT 30;
