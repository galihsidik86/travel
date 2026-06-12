-- Stage 223 — per-paket required documents. Different paket types need
-- different visa / health docs (Saudi umroh needs VISA_UMROH + VACCINE_MENINGITIS;
-- Turkey doesn't need visa). Admin curates the list; the S23 readiness
-- checklist uses it instead of a hardcoded set. JSON array of DocumentType
-- enum strings (validated in service layer). NULL = fall back to the
-- hardcoded default list (back-compat for existing paket).
ALTER TABLE `Paket`
  ADD COLUMN `requiredDocs` JSON NULL;
