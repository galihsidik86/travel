-- Stage 222 — per-paket WhatsApp group invite link for trip coordination.
-- Jemaah (LUNAS only) + crew see a "Gabung grup WA" CTA. Nullable so
-- existing paket render cleanly without the button.
ALTER TABLE `Paket`
  ADD COLUMN `waGroupUrl` VARCHAR(500) NULL;
