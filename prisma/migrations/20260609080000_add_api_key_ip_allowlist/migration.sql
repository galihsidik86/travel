-- Stage 135 — optional CIDR allowlist (JSON array). NULL = any IP.
ALTER TABLE `ApiKey` ADD COLUMN `allowedIps` JSON NULL;
