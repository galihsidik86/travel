-- AlterTable
ALTER TABLE `booking` ADD COLUMN `roomId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Room` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `roomNo` VARCHAR(191) NOT NULL,
    `floor` INTEGER NULL,
    `wing` VARCHAR(191) NULL,
    `kelas` ENUM('QUAD', 'TRIPLE', 'DOUBLE', 'VVIP') NOT NULL,
    `capacity` INTEGER NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Room_paketId_idx`(`paketId`),
    INDEX `Room_kelas_idx`(`kelas`),
    UNIQUE INDEX `Room_paketId_roomNo_key`(`paketId`, `roomNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Booking_roomId_idx` ON `Booking`(`roomId`);

-- AddForeignKey
ALTER TABLE `Room` ADD CONSTRAINT `Room_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `Room`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
