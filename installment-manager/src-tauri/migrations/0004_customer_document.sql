-- Customer document photos ("مستمسكات"): ID cards, contracts, and other
-- scanned/photographed paperwork tied to a customer.
--
-- Stored as a BLOB directly in SQLite rather than as separate files on
-- disk — this app's single database file is already the whole unit of
-- data/backup, and this avoids inventing a second storage location that
-- could drift out of sync with it (an orphaned file if the DB row is
-- deleted, or vice versa). Documents are a customer-editable attachment,
-- not ledger data, so unlike credit_sale/payment/audit_log this table is
-- not append-only — application code may delete a row (e.g. removing a
-- mis-uploaded photo).
CREATE TABLE customer_document (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customer (id),
    file_name    TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    content      BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_customer_document_customer_id ON customer_document (customer_id);
