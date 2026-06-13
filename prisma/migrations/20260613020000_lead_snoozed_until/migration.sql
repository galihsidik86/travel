-- Stage 266 — lead snooze. Hide leads from kanban until date elapses.
-- No cron needed — kanban query filters via `snoozedUntilAt: null OR
-- snoozedUntilAt <= now`. Nullable so back-compat with pre-S266 leads.
ALTER TABLE `Lead`
  ADD COLUMN `snoozedUntilAt` DATETIME(3) NULL;
