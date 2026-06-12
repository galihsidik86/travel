-- Stage 255 — admin recently-viewed trail. JSON array of
-- {kind, id, label, viewedAt} entries. Bounded to last 15 entries in
-- the service layer. NULL = never tracked (back-compat).
ALTER TABLE `User`
  ADD COLUMN `recentEntities` JSON NULL;
