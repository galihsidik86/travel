-- Adds AMOUNT_MISMATCH to AuditAction so the Midtrans webhook handler can
-- flag a gross_amount vs PaymentIntent.amount discrepancy for finance to
-- reconcile, instead of silently booking whichever figure the gateway sent.
ALTER TABLE `AuditLog`
  MODIFY `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'PRICE_CHANGE', 'STATUS_CHANGE', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'REFUND_ISSUED', 'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'EXPORT', 'AMOUNT_MISMATCH') NOT NULL;
