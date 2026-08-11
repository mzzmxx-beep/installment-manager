# Architecture

## 1. Overview

Local-first desktop application for managing installment-based credit sales
(cash price + manual markup → installment price), built as a single
distributable binary with an embedded database and offline license
enforcement. No backend server, no internet dependency for core operation.

## 2. Tech Stack

- **Frontend:** React 18 + TypeScript, built with Vite, styled with
  Tailwind CSS, components from Shadcn UI.
- **Desktop Wrapper & Backend:** Tauri 2.x (Rust). All business logic,
  database access, and licensing logic live in Rust.
- **Database:** SQLite, embedded, managed exclusively by Rust (via
  `rusqlite` or `sqlx` — decided in Phase 2).
- **Package manager:** pnpm (strict mode — no phantom dependencies).

## 3. Architecture Rule: Strict Decoupling

The frontend **never** touches SQLite directly. All data access goes
through Tauri Commands, treated as an **Internal API**:

```
React UI  --invoke()-->  Tauri Command (Rust)  -->  SQLite
```

Rules:
- Tauri commands are defined with typed request/response DTOs (Rust
  structs deriving `Serialize`/`Deserialize`), never raw SQL rows or
  `rusqlite` types crossing the boundary.
- Commands are named and shaped as if they were REST/RPC endpoints
  (e.g. `create_credit_sale(payload) -> CreditSaleDto`), not as thin
  wrappers around SQL statements.
- No business logic (markup calculation, rounding, validation) lives in
  the frontend — it is computed in Rust and returned as data.

**Why:** this makes the frontend's data layer a thin `invoke()` client.
To migrate to Cloudflare Pages (frontend) + Cloudflare D1 (database) +
Cloudflare Workers (API) later, only the transport changes
(`invoke("cmd", payload)` → `fetch("/api/cmd", {body: payload})`); command
signatures, DTOs, and all business logic in Rust carry over with zero
rewrite.

## 4. Tauri Commands (Internal API / IPC)

**IPC Boundary rule:** the React frontend must never construct or execute
raw SQL. Every database or OS interaction crosses through a strictly
typed Tauri Command written in Rust. Rust owns wrapping any multi-table
write (e.g. a sale plus its installments) in a single SQLite
transaction — partial writes must never be observable.

### System & Licensing
- `validate_license()` — checks the cryptographic HWID license and the
  anti-time-tampering timestamp (§7); returns the current lock state.
- `activate_license(key: String)` — decrypts, validates, and persists a
  new license key.

### Customer & Guarantor
- `create_customer(payload)` / `get_customers(search_term)`
- `create_guarantor(payload)` / `get_guarantors(search_term)`

### Product
- `create_product(payload)`
- `get_active_products()` — populates the sale flow's product dropdowns.

### Sales & Financial Engine (strictly transactional)
- `create_credit_sale(payload)` — opens a SQLite transaction: inserts
  `CreditSale`, inserts each `CreditSaleItem` (snapshotting
  `snapshot_cash_price`), computes the installment schedule with integer
  math (remainder folded into the final installment, per §5), inserts
  the `Installment` rows, then commits. Any failure rolls back the
  entire sale — a half-written sale must never be visible.

### Payment Engine (strictly transactional)
- `register_payment(payload)` — opens a SQLite transaction: inserts the
  `Payment` row (with its own manual exchange rate), then runs an
  allocation algorithm that walks the sale's unpaid installments
  oldest-first and inserts `PaymentAllocation` rows until the payment
  amount is fully distributed, then commits.

### Reporting & Dashboards
- `get_customer_statement(customer_id)` — derives total debt and
  remaining balance by joining `CreditSale` → `Installment` →
  `PaymentAllocation`; there is no stored balance column to read (§8).
- `get_overdue_installments(current_date)` — returns installments where
  `due_date < current_date` and
  `sum(PaymentAllocation.allocated_amount) < scheduled_amount`.

Every command above returns typed DTOs, never raw table rows (§3).

## 5. Financial Engine Rules

- **No floating-point math, anywhere, for money.** SQLite has no strict
  `DECIMAL` type and silently falls back to `REAL` (floating-point) for
  non-integer numeric columns, which introduces rounding errors.
  **Every financial column is therefore typed `INTEGER`** — no
  `REAL`/`FLOAT` columns are permitted for money, ever:
  - **USD** amounts are stored in cents (e.g. `$100.50` → `10050`).
  - **IQD** amounts are stored as the exact Dinar integer (e.g.
    `100,000 IQD` → `100000` — IQD has no minor unit in practice).
  - The **frontend** is solely responsible for formatting these raw
    integers into human-readable currency strings; Rust never emits
    pre-formatted currency text.
- Rounding behavior (e.g. round-half-up) is defined once in the
  financial engine and applied only at the final storage/display step —
  never mid-calculation. Any fractional remainder left when dividing
  `total_installment_price` evenly across `agreed_months` is added to
  the final installment, so the sum of all installments always equals
  the total exactly (never off by a rounding cent).
- **Flexible Markup:** `Cash Price + Custom Markup = Installment Price`.
  - Markup is entered manually per sale, either as a percentage or a
    flat amount (seller's choice per transaction).
  - Number of months is a manual input per sale.
  - Once a `CreditSale` is created, the resolved markup value, markup
    type, months, and computed installment price are saved as an
    **immutable snapshot** on that sale/plan. Later changes to any
    global config never retroactively change existing sales.
- **Manual Exchange Rate:** every `CreditSale` and every `Payment`
  carries its own manual `exchange_rate` field, entered at the time of
  the transaction. There is no hardcoded or auto-fetched rate anywhere
  in the system — IQD/USD volatility is handled per-transaction by the
  user.

## 6. Immutability Rule

- `CreditSale`, `Payment`, and `AuditLog` rows are **append-only**: the
  application never issues `UPDATE` or `DELETE` against these tables.
- Corrections/reversals are modeled as new, linked records (e.g. a
  reversal `Payment`), never as edits to history.
- Every mutating action across the app writes an entry to `AuditLog`.

## 7. Offline Licensing System

Implemented entirely in Rust (Tauri backend), no network calls required
for verification.

- **Asymmetric Cryptography:** a keypair is generated once, offline, by
  the vendor. The **private key never ships**; the **public key is
  embedded in the compiled binary**. License keys/files are signed with
  the private key and verified in-app with the embedded public key
  (candidate crate: `ed25519-dalek`).
- **HWID Binding:** at activation, Rust computes a stable hash derived
  from the machine's CPU ID and motherboard serial number (e.g. via
  `raw-cpuid` and platform WMI queries on Windows). The license is bound
  to this hash; it refuses to validate on a different machine.
- **Anti-Time-Tampering:** Rust persists an encrypted
  `last_execution_timestamp` in SQLite on every run. On startup, the
  current OS time is compared against this stored value:
  - if `current_time < last_execution_timestamp`, the app locks down
    immediately (refuses to proceed) — this catches users rolling the
    system clock back to defeat trial/expiry logic.
  - the stored timestamp is updated on every successful run.

## 8. Database Schema & Entities

Field-level specification (exact SQL types/constraints refined in Phase 2,
but the fields, semantics, and rules below are binding):

### Customer & Guarantor
- `Customer`: `id`, `name`, `phone`, `national_id`, `address`, `created_at`.
- `Guarantor`: `id`, `name`, `phone`, `national_id`, `address`, `created_at`.
- `national_id` is sensitive PII on both tables — enforce strict
  constraints (required, unique) and treat it as restricted data in any
  future export/reporting feature.

### Product (Reference Only)
- `Product`: `id`, `name`, `reference_cash_price` (INTEGER),
  `currency_code` (IQD/USD), `is_active`.
- Prices here are **templates only** — never read `Product` at sale-query
  time to compute or redisplay a historical sale's price; always use the
  snapshot on `CreditSaleItem`.

### CreditSale & CreditSaleItem (The Immutable Snapshot)
- `CreditSale`: `id`, `customer_id`, `guarantor_id`, `sale_date`,
  `agreed_months` (INTEGER), `applied_markup_value` (INTEGER — the
  resolved exact amount, not a percentage), `total_installment_price`
  (INTEGER), `currency_code`, `manual_exchange_rate` (INTEGER/TEXT for
  precision).
- `CreditSaleItem`: `id`, `sale_id`, `product_id`, `snapshot_cash_price`
  (INTEGER), `quantity`.
- Once a sale is created, these rows are **append-only**. Editing a
  `Product`'s price later must never alter an existing
  `snapshot_cash_price`. There is no separate `InstallmentPlan` table —
  `CreditSale` itself holds the resolved plan (`agreed_months`,
  `applied_markup_value`, `total_installment_price`), and `Installment`
  rows attach directly to it via `sale_id`.

### Installment (The Schedule)
- `Installment`: `id`, `sale_id`, `due_date` (TEXT ISO-8601),
  `scheduled_amount` (INTEGER), `status` (Pending, Partial, Paid).
- The financial engine deterministically divides `total_installment_price`
  by `agreed_months`; any fractional remainder is added to the **final**
  installment (see §5) so the schedule always sums exactly to the total.

### Payment & PaymentAllocation (The Ledger)
- `Payment`: `id`, `customer_id`, `payment_date`, `amount_paid`
  (INTEGER), `currency_code` (IQD/USD), `manual_exchange_rate` (required
  whenever the payment currency differs from the sale currency).
- `PaymentAllocation`: `id`, `payment_id`, `installment_id`,
  `allocated_amount` (INTEGER).
- Payments are distributed across specific installments via
  `PaymentAllocation`. An installment's remaining balance is always
  **computed** as `scheduled_amount` minus the sum of its
  `PaymentAllocation.allocated_amount` rows — there is **no mutable
  `balance_due` column anywhere**. This keeps the ledger derivable and
  tamper-evident instead of relying on a cached number that can drift.

### AuditLog (The Trace)
- `AuditLog`: `id`, `table_name`, `record_id`, `action`
  (INSERT/UPDATE/DELETE), `timestamp`, `old_payload` (JSON),
  `new_payload` (JSON).
- Populated via Rust command logic or SQLite triggers (decided in
  Phase 2/4). Strictly append-only, like every other ledger table in
  this system.

Relationships (indicative): `Customer` 1—N `CreditSale`; `CreditSale`
1—N `CreditSaleItem`; `CreditSale` 1—N `Installment` (direct
`sale_id` FK, no intermediate plan table); `Payment` N—N `Installment`
via `PaymentAllocation`; `CreditSale` N—1 `Guarantor`.

## 9. Cloud Migration Path (Future)

Because of the strict decoupling rule (§3), the intended future migration
to **Cloudflare Pages** (static frontend hosting) + **Cloudflare D1**
(SQLite-compatible edge database) + **Cloudflare Workers** (API layer)
requires no frontend rewrite and no business-logic rewrite:

- Tauri Commands → Worker HTTP handlers (same DTOs).
- `rusqlite`/`sqlx` queries against local SQLite → same SQL against D1
  (D1 is SQLite-compatible).
- React/Vite frontend deploys to Pages unchanged, swapping its
  `invoke()` calls for `fetch()` calls against the Worker API.
