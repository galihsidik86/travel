-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES', 'AGEN', 'MUTHAWWIF', 'JEMAAH') NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION') NOT NULL DEFAULT 'ACTIVE',
    `fullName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    INDEX `User_role_idx`(`role`),
    INDEX `User_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `igHandle` VARCHAR(191) NULL,
    `whatsapp` VARCHAR(191) NOT NULL,
    `bio` TEXT NULL,
    `tier` VARCHAR(191) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isVerified` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `AgentProfile_userId_key`(`userId`),
    UNIQUE INDEX `AgentProfile_slug_key`(`slug`),
    INDEX `AgentProfile_slug_idx`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JemaahProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `nik` VARCHAR(191) NULL,
    `passportNo` VARCHAR(191) NULL,
    `passportExpiry` DATETIME(3) NULL,
    `birthDate` DATETIME(3) NULL,
    `gender` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `emergencyContact` VARCHAR(191) NULL,
    `notes` TEXT NULL,

    UNIQUE INDEX `JemaahProfile_userId_key`(`userId`),
    UNIQUE INDEX `JemaahProfile_nik_key`(`nik`),
    UNIQUE INDEX `JemaahProfile_passportNo_key`(`passportNo`),
    INDEX `JemaahProfile_phone_idx`(`phone`),
    INDEX `JemaahProfile_passportExpiry_idx`(`passportExpiry`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StaffProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `department` VARCHAR(191) NULL,
    `position` VARCHAR(191) NULL,

    UNIQUE INDEX `StaffProfile_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrewProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `languages` VARCHAR(191) NULL,
    `experience` INTEGER NULL,

    UNIQUE INDEX `CrewProfile_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Paket` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `subtitle` VARCHAR(191) NULL,
    `arabicTagline` TEXT NULL,
    `translitTagline` TEXT NULL,
    `departureDate` DATETIME(3) NOT NULL,
    `returnDate` DATETIME(3) NOT NULL,
    `durationDays` INTEGER NOT NULL,
    `airline` VARCHAR(191) NULL,
    `airlineCode` VARCHAR(191) NULL,
    `routeFrom` VARCHAR(191) NULL,
    `routeTo` VARCHAR(191) NULL,
    `heroDescription` LONGTEXT NULL,
    `inclusions` JSON NOT NULL,
    `exclusions` JSON NOT NULL,
    `trustBadges` JSON NULL,
    `kursiTotal` INTEGER NOT NULL DEFAULT 45,
    `kursiTerisi` INTEGER NOT NULL DEFAULT 0,
    `manifestClosesAt` DATETIME(3) NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `publishedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Paket_slug_key`(`slug`),
    INDEX `Paket_slug_idx`(`slug`),
    INDEX `Paket_status_idx`(`status`),
    INDEX `Paket_departureDate_idx`(`departureDate`),
    INDEX `Paket_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaketHotel` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `city` ENUM('MADINAH', 'MEKKAH', 'JEDDAH', 'AQSA', 'PETRA', 'AMMAN', 'ISTANBUL', 'CAIRO', 'DUBAI', 'JAKARTA') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `stars` INTEGER NOT NULL,
    `distance` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `nights` INTEGER NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,

    INDEX `PaketHotel_paketId_idx`(`paketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaketHarga` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `kelas` ENUM('QUAD', 'TRIPLE', 'DOUBLE', 'VVIP') NOT NULL,
    `label` VARCHAR(191) NULL,
    `caption` VARCHAR(191) NULL,
    `priceIdr` DECIMAL(15, 2) NOT NULL,
    `cicilanIdr` DECIMAL(15, 2) NULL,
    `cicilanMonths` INTEGER NULL,
    `perks` JSON NULL,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,

    INDEX `PaketHarga_paketId_idx`(`paketId`),
    UNIQUE INDEX `PaketHarga_paketId_kelas_key`(`paketId`, `kelas`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaketDay` (
    `id` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `dayNumber` INTEGER NOT NULL,
    `dayRange` VARCHAR(191) NULL,
    `dateLabel` VARCHAR(191) NULL,
    `monthLabel` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `tags` JSON NULL,
    `highlight` BOOLEAN NOT NULL DEFAULT false,
    `pembimbingTitle` VARCHAR(191) NULL,
    `pembimbingNote` TEXT NULL,

    INDEX `PaketDay_paketId_idx`(`paketId`),
    UNIQUE INDEX `PaketDay_paketId_dayNumber_key`(`paketId`, `dayNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Booking` (
    `id` VARCHAR(191) NOT NULL,
    `bookingNo` VARCHAR(191) NOT NULL,
    `paketId` VARCHAR(191) NOT NULL,
    `jemaahId` VARCHAR(191) NOT NULL,
    `jemaahUserId` VARCHAR(191) NULL,
    `agentId` VARCHAR(191) NULL,
    `agentSlugCap` VARCHAR(191) NULL,
    `kelas` ENUM('QUAD', 'TRIPLE', 'DOUBLE', 'VVIP') NOT NULL,
    `paxCount` INTEGER NOT NULL DEFAULT 1,
    `notes` TEXT NULL,
    `totalAmount` DECIMAL(15, 2) NOT NULL,
    `paidAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `currency` ENUM('IDR', 'USD', 'SAR') NOT NULL DEFAULT 'IDR',
    `status` ENUM('PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `bookingFeeAt` DATETIME(3) NULL,
    `dpDueAt` DATETIME(3) NULL,
    `lunasDueAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Booking_bookingNo_key`(`bookingNo`),
    INDEX `Booking_paketId_idx`(`paketId`),
    INDEX `Booking_agentId_idx`(`agentId`),
    INDEX `Booking_status_idx`(`status`),
    INDEX `Booking_jemaahId_idx`(`jemaahId`),
    INDEX `Booking_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `bookingId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` ENUM('IDR', 'USD', 'SAR') NOT NULL DEFAULT 'IDR',
    `exchangeRate` DECIMAL(15, 6) NULL,
    `amountIdrEq` DECIMAL(15, 2) NULL,
    `method` ENUM('VA', 'QRIS', 'EWALLET', 'CARD', 'TRANSFER', 'CASH') NOT NULL,
    `gatewayRef` VARCHAR(191) NULL,
    `vaNumber` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `paidAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Payment_gatewayRef_key`(`gatewayRef`),
    INDEX `Payment_bookingId_idx`(`bookingId`),
    INDEX `Payment_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Komisi` (
    `id` VARCHAR(191) NOT NULL,
    `bookingId` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` ENUM('IDR', 'USD', 'SAR') NOT NULL DEFAULT 'IDR',
    `status` ENUM('PENDING', 'EARNED', 'PAID', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `earnedAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Komisi_agentId_idx`(`agentId`),
    INDEX `Komisi_bookingId_idx`(`bookingId`),
    INDEX `Komisi_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `actorRole` ENUM('OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES', 'AGEN', 'MUTHAWWIF', 'JEMAAH') NULL,
    `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'PRICE_CHANGE', 'STATUS_CHANGE', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'REFUND_ISSUED', 'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'EXPORT') NOT NULL,
    `entity` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_entity_entityId_idx`(`entity`, `entityId`),
    INDEX `AuditLog_actorUserId_idx`(`actorUserId`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    INDEX `AuditLog_action_idx`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentProfile` ADD CONSTRAINT `AgentProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JemaahProfile` ADD CONSTRAINT `JemaahProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StaffProfile` ADD CONSTRAINT `StaffProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrewProfile` ADD CONSTRAINT `CrewProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Paket` ADD CONSTRAINT `Paket_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaketHotel` ADD CONSTRAINT `PaketHotel_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaketHarga` ADD CONSTRAINT `PaketHarga_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaketDay` ADD CONSTRAINT `PaketDay_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_paketId_fkey` FOREIGN KEY (`paketId`) REFERENCES `Paket`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_jemaahId_fkey` FOREIGN KEY (`jemaahId`) REFERENCES `JemaahProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_jemaahUserId_fkey` FOREIGN KEY (`jemaahUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_bookingId_fkey` FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Komisi` ADD CONSTRAINT `Komisi_bookingId_fkey` FOREIGN KEY (`bookingId`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Komisi` ADD CONSTRAINT `Komisi_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `AgentProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
