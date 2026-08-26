-- Distinguishes a self-service free trial activation (no vendor-signed
-- license involved) from a real activated license, so validate_license can
-- apply a fixed local expiry instead of verifying a signature.
ALTER TABLE license_activation ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
