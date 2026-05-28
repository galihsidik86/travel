-- CreateTable
CREATE TABLE `JobRun` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `ok` BOOLEAN NOT NULL DEFAULT false,
    `scanned` INTEGER NULL,
    `affected` INTEGER NULL,
    `errors` INTEGER NOT NULL DEFAULT 0,
    `durationMs` INTEGER NULL,
    `detail` JSON NULL,
    `error` TEXT NULL,

    INDEX `JobRun_name_finishedAt_idx`(`name`, `finishedAt`),
    INDEX `JobRun_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
