-- Stage 185 — dormant-agen flag. Daily cron stamps `dormantSince`
-- when an ACTIVE agent has no booking + no lead activity in the
-- last 60d. Auto-clears (back to NULL) on the next run when fresh
-- activity is detected.
--
-- Nullable so pre-S185 agents (and all currently-active ones)
-- start as NULL. No index needed — the cron query scans all
-- ACTIVE agents which is a small N.
ALTER TABLE `AgentProfile`
  ADD COLUMN `dormantSince` DATETIME(3) NULL;
