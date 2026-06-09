-- Stage 157 — per-agent statement email opt-out.
ALTER TABLE `AgentProfile` ADD COLUMN `notifKomisiStatement` BOOLEAN NOT NULL DEFAULT true;
