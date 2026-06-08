-- S90: WA consent audit trail on JemaahProfile.
ALTER TABLE `JemaahProfile`
  ADD COLUMN `notifWaConsentAt` DATETIME(3) NULL,
  ADD COLUMN `notifWaWithdrawnAt` DATETIME(3) NULL;

-- No backfill — JemaahProfile has no createdAt column and stamping NOW()
-- for old rows would be a dishonest "consented just now" claim. Existing
-- profiles keep notifWaConsentAt=NULL; the admin view renders that as
-- "consent date unknown (pre-S90)" which is the truth.
