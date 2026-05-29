-- CreateTable
CREATE TABLE `AgentPaketKomisi` (
    `agentId` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `rate` DECIMAL(5, 4) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AgentPaketKomisi_paketId_idx`(`paketId`),
    PRIMARY KEY (`agentId`, `paketId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentPaketKomisi` ADD CONSTRAINT `AgentPaketKomisi_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentPaketKomisi` ADD CONSTRAINT `AgentPaketKomisi_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
