-- A guarantor is just an existing customer vouching for another customer's
-- sale, not a separate entity: retarget credit_sale.guarantor_id to
-- reference customer(id) instead of the standalone guarantor table, and
-- drop that table.
--
-- SQLite cannot ALTER a column's REFERENCES target directly, so this
-- rebuilds credit_sale via the standard create/copy/drop/rename procedure.
-- Any existing guarantor_id values are dropped (set to NULL) rather than
-- guessed at, since the old `guarantor` table's ids have no reliable
-- mapping onto `customer` ids.

CREATE TABLE credit_sale_new (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id              INTEGER NOT NULL REFERENCES customer (id),
    guarantor_id             INTEGER REFERENCES customer (id),
    sale_date                TEXT NOT NULL,
    agreed_months            INTEGER NOT NULL CHECK (agreed_months > 0),
    applied_markup_value     INTEGER NOT NULL,
    total_installment_price  INTEGER NOT NULL,
    currency_code            TEXT NOT NULL CHECK (currency_code IN ('IQD', 'USD')),
    manual_exchange_rate_micros INTEGER NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO credit_sale_new (
    id, customer_id, guarantor_id, sale_date, agreed_months, applied_markup_value,
    total_installment_price, currency_code, manual_exchange_rate_micros, created_at
)
SELECT id, customer_id, NULL, sale_date, agreed_months, applied_markup_value,
       total_installment_price, currency_code, manual_exchange_rate_micros, created_at
FROM credit_sale;

DROP TABLE credit_sale;
ALTER TABLE credit_sale_new RENAME TO credit_sale;
CREATE INDEX idx_credit_sale_customer_id ON credit_sale (customer_id);

DROP TABLE guarantor;
