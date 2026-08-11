# Roadmap

## Phase 1: Project Scaffolding & Git Init
- Initialize git repository (done as part of this doc-init task).
- Scaffold the Tauri + React project in place:
  `pnpm create tauri-app@latest . --manager pnpm --template react-ts`
- Install and configure Tailwind CSS and Shadcn UI.
- Verify `pnpm tauri dev` launches an empty shell app.
- **Exit criteria:** app builds and runs; repo committed.

## Phase 2: SQLite Schema & Rust Database Connection
- Choose and add the SQLite access crate (`rusqlite` or `sqlx`).
- Write migrations for all core entities (§8 of ARCHITECTURE.md):
  Customer, Guarantor, Product, CreditSale, CreditSaleItem, Installment,
  Payment, PaymentAllocation, AuditLog — all financial columns as
  `INTEGER` (cents for USD, exact Dinar units for IQD), no `REAL`/`FLOAT`
  columns.
- Wire up a Rust DB connection/pool accessible from Tauri command
  handlers, with the SQLite file stored in the app's local data dir.
- **Exit criteria:** schema applies cleanly on fresh install; basic
  CRUD-via-Tauri-command round-trip works for one entity (e.g. Customer).

## Phase 3: Rust Licensing Module (Crypto, HWID, Anti-Tamper)
- Generate the vendor keypair (offline, outside the repo); embed the
  public key in the app.
- Implement license file verification via asymmetric signature check.
- Implement HWID hash generation (CPU + motherboard) and binding check.
- Implement encrypted `last_execution_timestamp` persistence and the
  time-rollback lockdown check on startup.
- **Exit criteria:** app refuses to run without a valid, machine-bound
  license; refuses to run after a detected clock rollback.

## Phase 4: Core Financial Engine & Tauri Commands
- Implement the non-float decimal/integer math engine (markup
  application, installment schedule generation, payment allocation).
- Implement `CreditSale` creation (cash price + manual markup + manual
  months + manual exchange rate → immutable snapshot + generated
  `Installment` rows), per the transactional logic in §4 of
  ARCHITECTURE.md.
- Implement `Payment` recording with manual exchange rate and
  oldest-first allocation across outstanding `Installment`s.
- Implement the full Tauri Command surface from §4 of ARCHITECTURE.md
  (System & Licensing, Customer/Guarantor, Product, Sales, Payment,
  Reporting), respecting the strict IPC boundary rule (§3): no raw SQL
  reaches the frontend, every multi-table write is wrapped in a single
  SQLite transaction.
- Write `AuditLog` entries for every mutating command.
- **Exit criteria:** a full sale → schedule → payment → allocation
  cycle can be driven end-to-end via Tauri commands (e.g. from a test
  harness), with correct rounding and no floats anywhere in the path.

## Phase 5: Frontend UI (Sales, Installment Plans, Payments)
- Build Customer/Guarantor/Product management screens.
- Build the Credit Sale creation flow (cash price, manual markup entry,
  months, manual exchange rate, live installment preview).
- Build the Installment Plan / schedule view per sale.
- Build the Payment recording flow with allocation across installments.
- **Exit criteria:** a user can create a customer, make a credit sale,
  and record payments against it, entirely through the UI.

## Phase 6: Reporting (Customer Statements, Overdue Management)
- Customer statement view backed by `get_customer_statement(customer_id)`
  (full transaction history and derived balance for one customer).
- Overdue installments dashboard/list backed by
  `get_overdue_installments(current_date)`, sortable by days overdue.
- Export/print support for statements.
- **Exit criteria:** overdue installments are visible at a glance and a
  per-customer statement can be generated and printed/exported.
