-- Stage 50: Paket gains a variant-B hero title for A/B testing
ALTER TABLE `paket` ADD COLUMN `heroTitleHtmlVariantB` TEXT NULL;

-- Stage 50 + 51: PaketView captures variant + UTM tags
ALTER TABLE `PaketView`
  ADD COLUMN `heroVariant` VARCHAR(1) NULL,
  ADD COLUMN `utmSource`   VARCHAR(80) NULL,
  ADD COLUMN `utmMedium`   VARCHAR(80) NULL,
  ADD COLUMN `utmCampaign` VARCHAR(120) NULL;

-- Stage 49 + 50 + 51: Booking snapshots the attribution at create time
ALTER TABLE `booking`
  ADD COLUMN `firstViewAt` DATETIME(3) NULL,
  ADD COLUMN `viewCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `heroVariant` VARCHAR(1) NULL,
  ADD COLUMN `utmSource` VARCHAR(80) NULL,
  ADD COLUMN `utmMedium` VARCHAR(80) NULL,
  ADD COLUMN `utmCampaign` VARCHAR(120) NULL;
