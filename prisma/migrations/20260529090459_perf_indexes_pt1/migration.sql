-- Indexes for hot query paths. The Booking.jemaahUserId implicit FK index is
-- already named `Booking_jemaahUserId_idx` in the live DB, so adding
-- @@index([jemaahUserId]) to the schema is a no-op at the SQL level —
-- intentionally omitted from this migration.

CREATE INDEX `AuditLog_entity_createdAt_idx` ON `AuditLog`(`entity`, `createdAt`);
CREATE INDEX `PaymentIntent_createdAt_idx` ON `PaymentIntent`(`createdAt`);
CREATE INDEX `PaymentIntent_status_expiresAt_idx` ON `PaymentIntent`(`status`, `expiresAt`);
