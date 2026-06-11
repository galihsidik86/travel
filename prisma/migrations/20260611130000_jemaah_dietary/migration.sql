-- Stage 210 — jemaah dietary preference. Catering / hotel meal planning
-- uses this to plan special meals. REGULAR is the default; SOFT_TEXTURE
-- is for elderly jemaah who can't chew well; DIABETIC for sugar control.
-- Free-text `dietaryNotes` field carries specifics (e.g. allergies).
ALTER TABLE `JemaahProfile`
  ADD COLUMN `dietary` ENUM(
    'REGULAR',
    'VEGETARIAN',
    'HALAL_STRICT',
    'SOFT_TEXTURE',
    'DIABETIC',
    'OTHER'
  ) NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN `dietaryNotes` VARCHAR(500) NULL;
