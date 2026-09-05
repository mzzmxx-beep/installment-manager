# Architecture

## 1. Overview

Local-first desktop application for managing installment-based credit sales
(cash price + manual markup → installment price), built as a single
distributable binary with an embedded database and offline license
enforcement. No backend server, no internet dependency for core operation.

## 2. Tech Stack

- **Frontend:** React 19 + TypeScript, built with Vite, styled with
  Tailwind CSS, components from Shadcn UI.
- **Desktop Wrapper & Backend:** Tauri 2.x (Rust). All business logic,
  database access, and licensing logic live in Rust.
- **Database:** SQLite, embedded, managed exclusively by Rust — `rusqlite`
  (bundled feature) + `rusqlite_migration`.
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
- `validate_license()` — re-verifies the currently activated license's
  signature, HWID binding, expiry, and the anti-time-tampering
  timestamp (§7); returns a `LicenseStatus` (`NotActivated` / `Valid` /
  `Expired` / `Invalid` / `ClockRollbackDetected`). Called on every app
  startup; the frontend gates the entire UI behind this.
- `activate_license(payload: { license_key })` — verifies a new license
  string, binds it to this machine's HWID, and persists it (replacing
  any previous activation), returning the same `LicenseStatus`.

### Customer
- `create_customer(payload)` / `get_customers(search_term)`
- There is no separate Guarantor entity or command set. A guarantor is
  just another `Customer` row — `CreditSale.guarantor_id` references
  `Customer(id)` directly (see §8).

### Product
- `create_product(payload)`
- `get_active_products()` — populates the sale flow's product dropdowns,
  which may mix IQD- and USD-priced products in a single sale.

### Sales & Financial Engine (strictly transactional)
- `create_credit_sale(payload)` — opens a SQLite transaction: inserts
  `CreditSale`, inserts each `CreditSaleItem` (snapshotting
  `snapshot_cash_price` — converted into the sale's own currency first,
  via that sale's manual exchange rate, if the product is priced in the
  other currency), computes the installment schedule with integer math
  (remainder folded into the final installment, per §5), inserts
  the `Installment` rows, then commits. Any failure rolls back the
  entire sale — a half-written sale must never be visible. Rejects a
  customer guaranteeing their own sale.

### Payment Engine (strictly transactional)
- `register_payment(payload)` — opens a SQLite transaction: inserts the
  `Payment` row (with its own manual exchange rate), then runs an
  allocation algorithm that walks the customer's unpaid installments
  oldest-first — regardless of which currency each underlying sale is
  in, converting via this payment's own manual exchange rate when they
  differ — and inserts `PaymentAllocation` rows until the payment
  amount is fully distributed, then commits. Any leftover (overpayment,
  or nothing outstanding) is reported back rather than dropped.
- `payload.sale_id` (optional) narrows allocation to one `CreditSale`'s
  outstanding installments only, instead of walking the customer's
  installments across every sale. The payment UI exposes this as an
  invoice picker defaulting to "all invoices" (the original behavior).
  No schema change was needed for this — `Payment` still has no
  `sale_id` column; which sale(s) a payment actually reached is always
  derivable after the fact via `PaymentAllocation → Installment.sale_id`.

### Reporting & Dashboards
- `get_customer_statement(customer_id)` — a customer's full sales +
  payments history, plus outstanding balance per currency, derived
  fresh from `Installment`/`PaymentAllocation` every call; there is no
  stored balance column to read (§8).
- `get_overdue_installments(current_date)` — returns installments where
  `due_date < current_date` and
  `sum(PaymentAllocation.allocated_amount) < scheduled_amount`.

### Analytics (business-wide, beyond the original plan)
- `get_sales_summary(from_date?, to_date?)` — per-currency sale count,
  cash value, markup (profit), installment value, collected, and
  outstanding, optionally scoped to a date range.
- `get_top_products(limit)` — best-selling products by quantity, with
  revenue per currency.
- `get_top_customers(limit)` — customers ranked by number of completed
  sales.
- `get_most_overdue_customers(current_date, limit)` — customers ranked
  by their longest-overdue installment.
- `get_customers_overview()` — every customer's sale count, purchased
  and remaining totals per currency, and last sale date.
- All money aggregates that could span both currencies return a list of
  `{ currency_code, amount }` rather than a single number — there is no
  invented "reporting exchange rate" anywhere in the app.

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
  - Number of installments is a manual input per sale, spaced either
    monthly or daily (`installment_period_unit`, per-sale choice, added
    in migration `0006`) — daily spacing serves daily-collection sales.
  - Once a `CreditSale` is created, the resolved markup value, markup
    type, months, and computed installment price are saved as an
    **immutable snapshot** on that sale/plan. Later changes to any
    global config never retroactively change existing sales.
- **Manual Exchange Rate:** every `CreditSale` and every `Payment`
  carries its own manual `exchange_rate` field, entered at the time of
  the transaction. There is no hardcoded or auto-fetched rate anywhere
  in the system — IQD/USD volatility is handled per-transaction by the
  user.
- **Cross-Currency Conversion:** stored as `manual_exchange_rate_micros`
  — IQD per 1 USD, scaled by 1,000,000 (e.g. 1,310.25 IQD/USD →
  `1310250000`). Used in two places, always with the *current
  transaction's own* rate, never a global one: (1) a sale's items may
  be priced in either currency — a product's price is converted into
  the sale's currency before being summed into `cash_total`; (2) a
  payment may be in either currency — installments in the other
  currency are converted using that payment's rate as the payment is
  allocated across them oldest-first. `PaymentAllocation.allocated_amount`
  is always stored in the *installment's* currency (never the
  payment's), since it's summed directly against `scheduled_amount`.

## 6. Immutability Rule

- `CreditSale`, `Payment`, and `AuditLog` rows are **append-only**: the
  application never issues `UPDATE` or `DELETE` against these tables.
- Corrections/reversals are modeled as new, linked records (e.g. a
  reversal `Payment`), never as edits to history.
- Every mutating action across the app writes an entry to `AuditLog`.

## 7. Offline Licensing System

Implemented entirely in Rust (`src-tauri/src/licensing.rs`), no network
calls anywhere in the licensing path.

- **Asymmetric Cryptography (`ed25519-dalek`):** a keypair is generated
  once, offline, by the vendor, via `cargo run --bin keygen`. The
  **private key never ships and is never committed** — it lives in a
  file (`vendor_private_key.b64`) kept outside the repo entirely,
  currently at `C:\Users\mahmoodsaad\OneDrive\0001- الاقساط\installment-manager-vendor-key\`
  (rotated once after an earlier copy under a different, cross-profile
  path silently disappeared — see that folder's README.txt for the
  full note). The **public key is embedded in the compiled binary**
  (`licensing::PUBLIC_KEY_BYTES`). A license is the string
  `base64(payload json).base64(signature)`; `verify_license` always
  re-parses and re-verifies from that raw string rather than trusting
  any separately-stored field, so tampering with an individual DB
  column can't forge a license.
  - `vendor-tools/src/bin/issue_license.rs` is the vendor-facing tool
    that signs a new license from the private key: scriptable
    (`issue_license <key-path> "<name>" [--days N]`) or interactive
    (no args — finds the key file next to itself, prompts for the
    rest). Its own prompts are English-only on purpose: it's
    developer-only, never shown to a customer, and the legacy Windows
    console can't shape Arabic text correctly even with a UTF-8
    codepage. `keygen`/`issue_license` live in their own `vendor-tools`
    Cargo package (sibling to `src-tauri`, depending on it as a plain
    library dependency) rather than as extra `[[bin]]` targets inside
    `src-tauri` itself — see §10 for why.
- **HWID Binding:** at activation, Rust computes a stable hash (SHA-256)
  derived from the machine's CPU `ProcessorId`, motherboard serial
  number, and the Windows machine GUID — fetched in a single
  PowerShell/CIM call (console window suppressed) rather than
  `raw-cpuid`. The license is bound to this hash; it refuses to
  validate on a different machine.
- **Anti-Time-Tampering:** Rust persists an AES-256-GCM–encrypted
  `last_execution_timestamp` in the `license_activation` table (key
  derived from the HWID, so the ciphertext isn't portable to another
  machine) on every successful validation. On startup, the current OS
  time is compared against this stored value:
  - if `current_time < last_execution_timestamp`, the app locks down
    immediately (refuses to proceed, no way to dismiss it from the UI)
    — this catches users rolling the system clock back to defeat
    trial/expiry logic. The stored timestamp is deliberately **not**
    updated in this case.
  - otherwise, the stored timestamp is updated to the current time.
- **Frontend gate:** `App.tsx` mounts everything under `LicenseGate`
  (`src/features/license/LicenseGate.tsx`), which calls
  `validate_license()` on load and renders an activation form (not
  activated / invalid / expired) or the hard lockdown screen instead of
  the app until the license checks out.

## 8. Database Schema & Entities

Field-level specification (exact SQL types/constraints refined in Phase 2,
but the fields, semantics, and rules below are binding):

### Customer
- `Customer`: `id`, `name`, `phone`, `national_id`, `address`, `created_at`.
- `national_id` is sensitive PII — enforce strict constraints (required,
  unique) and treat it as restricted data in any future export/reporting
  feature.
- There is **no separate `Guarantor` table** (removed via migration
  `0002`, which retargeted `CreditSale.guarantor_id` onto `Customer(id)`
  — see below). A guarantor is just another customer.

### Product (Reference Only)
- `Product`: `id`, `name`, `reference_cash_price` (INTEGER),
  `currency_code` (IQD/USD), `is_active`.
- Prices here are **templates only** — never read `Product` at sale-query
  time to compute or redisplay a historical sale's price; always use the
  snapshot on `CreditSaleItem`.

### CreditSale & CreditSaleItem (The Immutable Snapshot)
- `CreditSale.id` doubles as the user-facing invoice number (shown in
  the UI as "فاتورة #{id}") — no separate `invoice_number` column.
  SQLite's `AUTOINCREMENT` already guarantees it's unique and
  sequential, so a redundant second identifier would only risk drifting
  out of sync with the real one.
- `CreditSale`: `id`, `customer_id`, `guarantor_id` (nullable FK to
  **`Customer`**, not a separate table — must differ from
  `customer_id`), `sale_date`, `agreed_months` (INTEGER — the installment
  *count*, regardless of unit; kept its original name across migration
  `0006` rather than being renamed, since it only ever meant "how many
  installments"), `installment_period_unit` (TEXT, `'months'` or
  `'days'`, default `'months'` — added by migration `0006`; says how far
  apart each installment's due date is spaced, see §5),
  `applied_markup_value` (INTEGER — the resolved exact amount, not a
  percentage), `total_installment_price` (INTEGER), `currency_code`,
  `manual_exchange_rate_micros` (INTEGER, IQD per 1 USD ×1,000,000).
- `CreditSaleItem`: `id`, `sale_id`, `product_id`, `snapshot_cash_price`
  (INTEGER), `quantity`. No currency column of its own —
  `snapshot_cash_price` is always in the parent `CreditSale`'s
  currency, converted at creation time from the `Product`'s own
  currency if they differ (§5).
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
  Due dates are spaced one `installment_period_unit` apart (one calendar
  month, or one day) starting one unit after `sale_date` — the unit is a
  per-sale choice, immutable once the sale is created, same as everything
  else on `CreditSale` (§6).

### Payment & PaymentAllocation (The Ledger)
- `Payment`: `id`, `customer_id`, `payment_date`, `amount_paid`
  (INTEGER), `currency_code` (IQD/USD), `manual_exchange_rate_micros`
  (used whenever any of this customer's outstanding installments are in
  the other currency — §5).
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
- Populated via Rust command logic (`audit::log_insert`/`log_update`,
  one call site per mutating repo function) — decided against SQLite
  triggers. Strictly append-only, like every other ledger table in
  this system.

### LicenseActivation (§7)
- `license_activation`: a singleton row (`id` always `1` — activating a
  new license replaces it), `raw_license` (the full signed license
  string, re-verified from scratch on every check), `hwid`,
  `activated_at`, `encrypted_last_execution_ts` (BLOB, AES-256-GCM).

Relationships (indicative): `Customer` 1—N `CreditSale`; `CreditSale`
1—N `CreditSaleItem`; `CreditSale` 1—N `Installment` (direct
`sale_id` FK, no intermediate plan table); `Payment` N—N `Installment`
via `PaymentAllocation`; `CreditSale` N—1 `Customer` (as guarantor, via
`guarantor_id` — the same table as the buyer, not a distinct entity).

## 9. Cloud Migration Path (Future)

Because of the strict decoupling rule (§3), the intended future migration
to **Cloudflare Pages** (static frontend hosting) + **Cloudflare D1**
(SQLite-compatible edge database) + **Cloudflare Workers** (API layer)
requires no frontend rewrite and no business-logic rewrite:

- Tauri Commands → Worker HTTP handlers (same DTOs).
- `rusqlite` queries against local SQLite → same SQL against D1 (D1 is
  SQLite-compatible).
- React/Vite frontend deploys to Pages unchanged, swapping its
  `invoke()` calls for `fetch()` calls against the Worker API.

## 10. Distribution & Build

- `pnpm tauri build` (bundle target pinned to `["nsis"]` in
  `tauri.conf.json` — a plain installable `.exe`; MSI/WiX isn't used).
  Produces `installment-manager_<version>_x64-setup.exe` under
  `src-tauri/target/release/bundle/nsis/`.
- **`vendor-tools` (`keygen`, `issue_license`) is a separate Cargo
  package, not extra `[[bin]]` targets inside `src-tauri`.** This is
  the real fix for a bug hit in practice: with three `[[bin]]` targets
  in one package (`installment-manager`, `keygen`, `issue_license`),
  `tauri build`'s NSIS bundling step packaged `issue_license.exe`
  *renamed as* `installment-manager.exe` — even with `mainBinaryName`
  correctly set and the build log correctly reporting
  `Built application at: ...\installment-manager.exe`. Stale leftover
  binaries from an earlier build layout in `target/release/`
  (`deps/issue_license.exe` etc.) were implicated; `mainBinaryName`
  alone did not reliably prevent it from recurring. Isolating the
  vendor tools into their own package means `src-tauri`'s release build
  only ever has one binary target, so there is nothing left to
  bundle by mistake. `"mainBinaryName": "installment-manager"` is kept
  set regardless, as cheap defense-in-depth.
  - **After any future release build, verify the installed binary is
    really the GUI app before trusting it** — hashing the exe is
    *not* reliable for this (Rust release builds aren't
    byte-reproducible between separate `cargo build` invocations, so
    two legitimately-identical builds can still have different
    hashes). Instead, launch the installed exe and confirm it opens a
    real window with no console/stdout output (e.g. via
    `Start-Process -RedirectStandardOutput` and checking both
    `MainWindowTitle` and that stdout is empty) — `issue_license`'s
    interactive prompts are unmistakable if it's ever bundled by
    mistake again.
  - To rebuild the vendor tools: `cd vendor-tools && cargo build
    --release --bin keygen` / `--bin issue_license` (previously run
    from `src-tauri`).
- **`bundle.windows.webviewInstallMode` is set to `offlineInstaller`**
  in `tauri.conf.json` (not Tauri's default `downloadBootstrapper`).
  This embeds the full WebView2 Runtime installer (~150MB, hence the
  larger `.exe`) so installation never depends on internet access on
  the customer's machine — consistent with the app's offline-first
  design (§1). The trade-off (installer size) was a deliberate choice
  over the smaller `downloadBootstrapper`/`embedBootstrapper` modes,
  which need internet at install time if WebView2 isn't already
  present.
- A fresh install carries no data: the SQLite database is created empty
  in the OS-specific app-local-data directory
  (`%LOCALAPPDATA%\com.installmentmanager.app\installment_manager.sqlite3`,
  keyed off `tauri.conf.json`'s `identifier` — distinct from the
  install directory, `%LOCALAPPDATA%\installment-manager\`, which
  holds only the executable) on first run. Because these two
  directories are separate and the NSIS installer never touches the
  former, **updating to a newer version is just running the new
  installer over the old one — no uninstall needed, and existing data
  (including the activated license, stored in that same database) is
  untouched.** Any new migration still applies automatically and
  additively on first launch of the new version.
- On Windows, this bundled SQLite build defaults `PRAGMA foreign_keys`
  to ON (not SQLite's usual off-by-default) — relevant to any future
  migration that rebuilds a table (create/copy/drop/rename, needed
  whenever a `REFERENCES` target changes), which must toggle it off
  first or the `DROP TABLE` step fails against any database that
  already has real data in it (`db.rs` handles this for `init_db`/
  `init_test_db`; a regression test template for this scenario lives at
  `db::tests::migration_0002_succeeds_against_a_database_with_existing_child_rows`).
