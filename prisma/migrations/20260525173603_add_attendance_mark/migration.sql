-- CreateTable
CREATE TABLE `AttendanceMark` (
    `id` VARCHAR(191) NOT NULL,
    `bookingId` VARCHAR(191) NOT NULL,
    `paketDayId` VARCHAR(191) NOT NULL,
    `present` BOOLEAN NOT NULL DEFAULT true,
    `notes` TEXT NULL,
    `markedByUserId` VARCHAR(191) NOT NULL,
    `markedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AttendanceMark_paketDayId_idx`(`paketDayId`),
    INDEX `AttendanceMark_bookingId_idx`(`bookingId`),
    UNIQUE INDEX `AttendanceMark_bookingId_paketDayId_key`(`bookingId`, `paketDayId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AttendanceMark` ADD CONSTRAINT `AttendanceMark_bookingId_fkey` FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceMark` ADD CONSTRAINT `AttendanceMark_paketDayId_fkey` FOREIGN KEY (`paketDayId`) REFERENCES `PaketDay`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceMark` ADD CONSTRAINT `AttendanceMark_markedByUserId_fkey` FOREIGN KEY (`markedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
