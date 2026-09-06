-- Records which D1 binding on installment-api serves each tenant. See
-- the column comment in 0001_init.sql for why this exists (D1's HTTP
-- management API can't provide the atomicity money-critical writes
-- need, so tenants are served through real Worker bindings instead,
-- added dynamically by cloud/admin's provisioning flow).
ALTER TABLE tenant ADD COLUMN binding_name TEXT;
