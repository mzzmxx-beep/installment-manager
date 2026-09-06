-- Tracks failed login attempts (both tenant-account logins on
-- installment-api and the single admin login on installment-admin-api,
-- distinguished by `scope`) so both can rate-limit brute-force guessing.
-- Rows are opportunistically pruned by the same query that reads them --
-- see repo/rateLimit.ts equivalents in both Workers.
CREATE TABLE login_attempt (
    email        TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('tenant', 'admin')),
    attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_login_attempt_email_scope_time ON login_attempt (email, scope, attempted_at);
