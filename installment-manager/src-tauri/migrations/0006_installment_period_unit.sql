-- Lets a sale's installment schedule be spaced by days instead of always by
-- calendar month (e.g. a daily-collection credit sale), per direct request.
-- `agreed_months` keeps its name and still holds the installment *count*
-- regardless of unit (renaming it would touch every query/DTO for no
-- behavioral gain) — this column only says how due dates are spaced apart.
ALTER TABLE credit_sale
    ADD COLUMN installment_period_unit TEXT NOT NULL DEFAULT 'months'
        CHECK (installment_period_unit IN ('months', 'days'));
