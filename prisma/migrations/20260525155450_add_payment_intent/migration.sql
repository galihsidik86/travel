-- CreateTable
CREATE TABLE `PaymentIntent` (
    `id` VARCHAR(191) NOT NULL,
    `bookingId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'MIDTRANS',
    `orderId` VARCHAR(191) NOT NULL,
    `snapToken` TEXT NULL,
    `snapRedirectUrl` TEXT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `status` ENUM('CREATED', 'PENDING', 'SETTLED', 'EXPIRED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'CREATED',
    `gatewayStatus` VARCHAR(191) NULL,
    `gatewayPayload` JSON NULL,
    `paymentId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentIntent_orderId_key`(`orderId`),
    UNIQUE INDEX `PaymentIntent_paymentId_key`(`paymentId`),
    INDEX `PaymentIntent_bookingId_idx`(`bookingId`),
    INDEX `PaymentIntent_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentIntent` ADD CONSTRAINT `PaymentIntent_bookingId_fkey` FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentIntent` ADD CONSTRAINT `PaymentIntent_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
