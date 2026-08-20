-- Initial schema for the installment manager.
--
-- Conventions binding across every migration in this file (see ARCHITECTURE.md §5, §8):
--   * No REAL/FLOAT columns are ever used for money. USD is stored in cents,
--     IQD is stored as exact Dinar integers.
--   * Every `*_exchange_rate` column stores the rate scaled by 1,000,000
--     (six decimal places of fixed-point precision), e.g. a rate of
--     1310.25 IQD per 1 USD is stored as 1310250000. This keeps exchange
--     rate math integer-only while still being precise enough for
--     real-world quotes.
--   * `CreditSale`, `Payment`, and `AuditLog` are append-only: application
--     code must never UPDATE or DELETE rows in these tables.

CREATE TABLE customer (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT,
    national_id TEXT NOT NULL,
    address     TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_customer_national_id ON customer (national_id);

CREATE TABLE guarantor (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT,
    national_id TEXT NOT NULL,
    address     TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_guarantor_national_id ON guarantor (national_id);

CREATE TABLE product (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    reference_cash_price INTEGER NOT NULL,
    currency_code        TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- The immutable snapshot: once created, a CreditSale and its items are
-- never updated or deleted by application code.
CREATE TABLE credit_sale (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id              INTEGER NOT NULL REFERENCES customer (id),
    guarantor_id             INTEGER REFERENCES guarantor (id),
    sale_date                TEXT NOT NULL,
    agreed_months            INTEGER NOT NULL CHECK (agreed_months > 0),
    applied_markup_value     INTEGER NOT NULL,
    total_installment_price  INTEGER NOT NULL,
    currency_code            TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    manual_exchange_rate_micros INTEGER NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_credit_sale_customer_id ON credit_sale (customer_id);

CREATE TABLE credit_sale_item (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id              INTEGER NOT NULL REFERENCES credit_sale (id),
    product_id           INTEGER NOT NULL REFERENCES product (id),
    snapshot_cash_price  INTEGER NOT NULL,
    quantity             INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_credit_sale_item_sale_id ON credit_sale_item (sale_id);
CREATE INDEX idx_credit_sale_item_product_id ON credit_sale_item (product_id);

CREATE TABLE installment (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id           INTEGER NOT NULL REFERENCES credit_sale (id),
    due_date          TEXT NOT NULL,
    scheduled_amount  INTEGER NOT NULL CHECK (scheduled_amount > 0),
    status            TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Partial', 'Paid'))
);
CREATE INDEX idx_installment_sale_id ON installment (sale_id);
CREATE INDEX idx_installment_due_date ON installment (due_date);

-- The ledger: append-only, never updated or deleted by application code.
CREATE TABLE payment (
    id                           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id                  INTEGER NOT NULL REFERENCES customer (id),
    payment_date                 TEXT NOT NULL,
    amount_paid                  INTEGER NOT NULL CHECK (amount_paid > 0),
    currency_code                TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    manual_exchange_rate_micros  INTEGER NOT NULL,
    created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_payment_customer_id ON payment (customer_id);

CREATE TABLE payment_allocation (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id        INTEGER NOT NULL REFERENCES payment (id),
    installment_id    INTEGER NOT NULL REFERENCES installment (id),
    allocated_amount  INTEGER NOT NULL CHECK (allocated_amount > 0)
);
CREATE INDEX idx_payment_allocation_payment_id ON payment_allocation (payment_id);
CREATE INDEX idx_payment_allocation_installment_id ON payment_allocation (installment_id);

-- The trace: append-only, never updated or deleted by application code.
CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name   TEXT NOT NULL,
    record_id    INTEGER NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    old_payload  TEXT,
    new_payload  TEXT
);
CREATE INDEX idx_audit_log_table_record ON audit_log (table_name, record_id);
