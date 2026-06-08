-- Stage 74: agent profile photo for public /a/:slug page
ALTER TABLE `agentprofile` ADD COLUMN `photoUrl` VARCHAR(255) NULL;
