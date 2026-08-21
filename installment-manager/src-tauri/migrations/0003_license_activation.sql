-- Local, offline license activation state (ARCHITECTURE.md §7). A
-- singleton row (id is always 1): activating a new license replaces it.
--
-- `raw_license` is the full signed license string exactly as issued —
-- validation always re-parses and re-verifies from this, never trusts
-- `hwid` or the other columns on their own, so editing a column directly
-- can't forge a valid license.
--
-- `encrypted_last_execution_ts` is an AES-256-GCM blob (nonce || ciphertext)
-- of the last successful run's unix timestamp, bound to `hwid`, checked on
-- every startup to detect the system clock being rolled back.
CREATE TABLE license_activation (
    id                           INTEGER PRIMARY KEY CHECK (id = 1),
    raw_license                  TEXT NOT NULL,
    hwid                         TEXT NOT NULL,
    activated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    encrypted_last_execution_ts  BLOB NOT NULL
);
