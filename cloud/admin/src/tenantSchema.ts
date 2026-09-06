// Embedded copy of cloud/tenant-template/schema/0001_init.sql, applied to
// every newly-provisioned tenant database via the Cloudflare D1 HTTP API
// (see index.ts's POST /admin/tenants). Workers can't read files from
// disk at runtime, so this has to be a literal string baked into the
// bundle rather than an import of the .sql file itself.
//
// IMPORTANT: keep this in sync with cloud/tenant-template/schema/0001_init.sql
// by hand -- there is no automated check that they match.
const TENANT_SCHEMA_SQL = `
CREATE TABLE customer (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT,
    national_id TEXT NOT NULL,
    address     TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_customer_national_id ON customer (national_id);

CREATE TABLE product (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    reference_cash_price INTEGER NOT NULL,
    currency_code        TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE credit_sale (
    id                          TEXT PRIMARY KEY,
    customer_id                 TEXT NOT NULL REFERENCES customer (id),
    guarantor_id                TEXT REFERENCES customer (id),
    sale_date                   TEXT NOT NULL,
    agreed_months               INTEGER NOT NULL CHECK (agreed_months > 0),
    installment_period_unit     TEXT NOT NULL DEFAULT 'months'
                                     CHECK (installment_period_unit IN ('months', 'days')),
    applied_markup_value        INTEGER NOT NULL,
    total_installment_price     INTEGER NOT NULL,
    currency_code               TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    manual_exchange_rate_micros INTEGER NOT NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_credit_sale_customer_id ON credit_sale (customer_id);

CREATE TABLE credit_sale_item (
    id                   TEXT PRIMARY KEY,
    sale_id              TEXT NOT NULL REFERENCES credit_sale (id),
    product_id           TEXT NOT NULL REFERENCES product (id),
    snapshot_cash_price  INTEGER NOT NULL,
    quantity             INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_credit_sale_item_sale_id ON credit_sale_item (sale_id);
CREATE INDEX idx_credit_sale_item_product_id ON credit_sale_item (product_id);

CREATE TABLE installment (
    id                TEXT PRIMARY KEY,
    sale_id           TEXT NOT NULL REFERENCES credit_sale (id),
    due_date          TEXT NOT NULL,
    scheduled_amount  INTEGER NOT NULL CHECK (scheduled_amount > 0),
    status            TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Partial', 'Paid'))
);
CREATE INDEX idx_installment_sale_id ON installment (sale_id);
CREATE INDEX idx_installment_due_date ON installment (due_date);

CREATE TABLE payment (
    id                           TEXT PRIMARY KEY,
    customer_id                  TEXT NOT NULL REFERENCES customer (id),
    payment_date                 TEXT NOT NULL,
    amount_paid                  INTEGER NOT NULL CHECK (amount_paid > 0),
    currency_code                TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    manual_exchange_rate_micros  INTEGER NOT NULL,
    created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_payment_customer_id ON payment (customer_id);

CREATE TABLE payment_allocation (
    id                TEXT PRIMARY KEY,
    payment_id        TEXT NOT NULL REFERENCES payment (id),
    installment_id    TEXT NOT NULL REFERENCES installment (id),
    allocated_amount  INTEGER NOT NULL CHECK (allocated_amount > 0)
);
CREATE INDEX idx_payment_allocation_payment_id ON payment_allocation (payment_id);
CREATE INDEX idx_payment_allocation_installment_id ON payment_allocation (installment_id);

CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY,
    table_name   TEXT NOT NULL,
    record_id    TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    old_payload  TEXT,
    new_payload  TEXT
);
CREATE INDEX idx_audit_log_table_record ON audit_log (table_name, record_id);
`;

export function tenantSchemaStatements(): string[] {
  return TENANT_SCHEMA_SQL
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
