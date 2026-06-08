-- S115: per-ApiKey rate limit column.
ALTER TABLE `ApiKey`
  ADD COLUMN `rateLimitPerMin` INT NOT NULL DEFAULT 60;
