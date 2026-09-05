# Roadmap

## Status (2026-08-23)

**All 6 original phases are complete**, plus unplanned Phases 7 and 8.
The app has a working end-to-end flow (customers, products, credit
sales, payments, licensing, reporting), a distributable offline-capable
Windows installer (v1.0.0) has been built and used to update a real,
already-in-use install without touching its data, and the app has been
used with real (non-test) data. See ARCHITECTURE.md for the as-built
design — several details below evolved during implementation;
ARCHITECTURE.md reflects the final version, this file is left as a
historical log of what was planned per phase.

Known deviations from the original plan, folded into ARCHITECTURE.md:
- **Guarantor is no longer a separate entity.** `CreditSale.guarantor_id`
  references `Customer` directly — any existing customer can guarantee
  another customer's sale. The standalone `Guarantor` table/commands
  were removed after the MVP.
- **Cross-currency support was added** beyond the original spec: a
  payment in either currency can pay down installments in the other
  currency (converted via that payment's manual exchange rate), and a
  sale can include products priced in either currency (converted into
  the sale's currency at creation time, via that sale's manual exchange
  rate). Same "no hardcoded/global rate" rule as before — every
  conversion uses a rate entered on that specific transaction.

## Phase 1: Project Scaffolding & Git Init — ✅ Complete
- Initialize git repository (done as part of this doc-init task).
- Scaffold the Tauri + React project in place:
  `pnpm create tauri-app@latest . --manager pnpm --template react-ts`
- Install and configure Tailwind CSS and Shadcn UI.
- Verify `pnpm tauri dev` launches an empty shell app.
- **Exit criteria:** app builds and runs; repo committed.

## Phase 2: SQLite Schema & Rust Database Connection — ✅ Complete
- Choose and add the SQLite access crate (`rusqlite` or `sqlx`) —
  **decided: `rusqlite` with the `bundled` feature**, plus
  `rusqlite_migration` for migrations.
- Write migrations for all core entities (§8 of ARCHITECTURE.md):
  Customer, Guarantor, Product, CreditSale, CreditSaleItem, Installment,
  Payment, PaymentAllocation, AuditLog — all financial columns as
  `INTEGER` (cents for USD, exact Dinar units for IQD), no `REAL`/`FLOAT`
  columns.
- Wire up a Rust DB connection/pool accessible from Tauri command
  handlers, with the SQLite file stored in the app's local data dir.
- **Exit criteria:** schema applies cleanly on fresh install; basic
  CRUD-via-Tauri-command round-trip works for one entity (e.g. Customer).
- *Note:* migration `0002` later retargeted `guarantor_id` onto
  `Customer` and dropped the standalone `Guarantor` table; migration
  `0003` added `license_activation`. Real gotcha hit and fixed: this
  bundled SQLite defaults `PRAGMA foreign_keys` to ON, which blocks a
  create/copy/drop/rename migration unless it's toggled off first —
  see `db.rs`.

## Phase 3: Rust Licensing Module (Crypto, HWID, Anti-Tamper) — ✅ Complete
- Generate the vendor keypair (offline, outside the repo); embed the
  public key in the app. **Done via `src-tauri/src/bin/keygen.rs`** —
  private key lives outside the repo (see ARCHITECTURE.md §7 for the
  current location and the incident that led to rotating it once).
- Implement license file verification via asymmetric signature check —
  **`ed25519-dalek`**, confirmed (not just a candidate).
- Implement HWID hash generation (CPU + motherboard) and binding check
  — **implemented via one PowerShell/CIM call** (`Win32_Processor` +
  `Win32_BaseBoard` + the Windows machine GUID), SHA-256 hashed, not
  `raw-cpuid`.
- Implement encrypted `last_execution_timestamp` persistence and the
  time-rollback lockdown check on startup — **AES-256-GCM**, key
  derived from the HWID.
- **Exit criteria:** app refuses to run without a valid, machine-bound
  license; refuses to run after a detected clock rollback. ✅ Met —
  the whole app is gated behind `LicenseGate` on the frontend.
- *Extra:* a companion `issue_license` tool (scriptable + an
  interactive double-click mode) lets the vendor issue new customer
  licenses without touching code.

## Phase 4: Core Financial Engine & Tauri Commands — ✅ Complete
- Implement the non-float decimal/integer math engine (markup
  application, installment schedule generation, payment allocation).
- Implement `CreditSale` creation (cash price + manual markup + manual
  months + manual exchange rate → immutable snapshot + generated
  `Installment` rows), per the transactional logic in §4 of
  ARCHITECTURE.md.
- Implement `Payment` recording with manual exchange rate and
  oldest-first allocation across outstanding `Installment`s — **later
  extended to cross-currency allocation** (see deviations above).
- Implement the full Tauri Command surface from §4 of ARCHITECTURE.md
  (System & Licensing, Customer/Guarantor, Product, Sales, Payment,
  Reporting), respecting the strict IPC boundary rule (§3): no raw SQL
  reaches the frontend, every multi-table write is wrapped in a single
  SQLite transaction.
- Write `AuditLog` entries for every mutating command.
- **Exit criteria:** a full sale → schedule → payment → allocation
  cycle can be driven end-to-end via Tauri commands (e.g. from a test
  harness), with correct rounding and no floats anywhere in the path.
  ✅ Met — covered by the Rust test suite (40+ tests).

## Phase 5: Frontend UI (Sales, Installment Plans, Payments) — ✅ Complete
- Build Customer/Guarantor/Product management screens — **Guarantor
  picker now sources from Customers** (see deviations above), no
  separate Guarantor screen.
- Build the Credit Sale creation flow (cash price, manual markup entry,
  months, manual exchange rate, live installment preview).
- Build the Installment Plan / schedule view per sale.
- Build the Payment recording flow with allocation across installments.
- **Exit criteria:** a user can create a customer, make a credit sale,
  and record payments against it, entirely through the UI. ✅ Met.

## Phase 6: Reporting (Customer Statements, Overdue Management) — ✅ Complete
- Customer statement view backed by `get_customer_statement(customer_id)`
  (full transaction history and derived balance for one customer) —
  standalone printable page, `window.print()` covers export-to-PDF.
- Overdue installments dashboard/list backed by
  `get_overdue_installments(current_date)`, sortable by days overdue.
- Export/print support for statements — via the browser print dialog,
  no PDF-generation dependency needed.
- **Exit criteria:** overdue installments are visible at a glance and a
  per-customer statement can be generated and printed/exported. ✅ Met.

## Phase 7: Analytics & Distribution (not in the original plan) — ✅ Complete
Added after the original 6 phases, per direct request:
- Analytics/reports tab ("التقارير"): sales & profit summary (with
  all-time/this-year/this-month filters), best-selling products, top
  customers by sale count, most-overdue-customers ranking, and an
  all-customers overview table.
- A distributable Windows installer (`tauri build`, NSIS target only —
  a plain installable `.exe`, no MSI). Real gotcha hit and fixed: with
  multiple `[[bin]]` targets in the crate (the app plus the license
  tools), Tauri's build guessed the wrong binary to bundle; fixed via
  `"mainBinaryName"` in `tauri.conf.json` — keep that field set on any
  future release build.
- **Exit criteria:** a fresh install (no bundled data — the SQLite DB
  is created empty on first run, entirely separate from the installer)
  produces a fully working, licensed, reportable installment-tracking
  app.

## Phase 8: Invoicing, Payment-Reliability, and Distribution Hardening (not in the original plan) — ✅ Complete
Added 2026-08-23, per direct request:
- **Invoice numbers**: every `CreditSale` is now shown to the user as
  "فاتورة #{id}" (its existing `id`, not a new column — see
  ARCHITECTURE.md §8) on the customer detail screen and the printable
  customer statement.
- **Invoice-scoped payments**: `register_payment` accepts an optional
  `sale_id` to allocate a payment to one invoice's outstanding
  installments only, instead of always spreading it across every sale
  the customer has. The payment form gained an invoice picker
  defaulting to "all invoices" (the original, still-available
  behavior). No migration needed.
- **Combined monthly installment total**: the customer detail screen
  now shows, per currency, the sum of the monthly installment amount
  across all of that customer's still-open sales, next to the existing
  remaining-balance figure — computed client-side from data already
  fetched, no new backend command.
- **Fixed a real NSIS packaging bug**: `tauri build` had been bundling
  the `issue_license` vendor tool renamed as `installment-manager.exe`
  into the installer, discovered when a real install prompted for the
  vendor's private key on launch instead of opening the app. Root-caused
  and fixed by moving `keygen`/`issue_license` out of `src-tauri` into
  their own `vendor-tools` Cargo package — see ARCHITECTURE.md §10 for
  the full story and why `mainBinaryName` alone wasn't a reliable fix.
- **Switched to an offline-capable installer**: `webviewInstallMode` is
  now `offlineInstaller` (embeds the full WebView2 Runtime, ~150MB)
  instead of Tauri's default `downloadBootstrapper`, so installation no
  longer needs internet access on the customer's machine.
- Version bumped to **1.0.0**, built, and used to update a real existing
  install on the vendor's own machine — confirmed via matching database
  file hashes before/after that the update did not touch existing data.
- **Exit criteria:** a rebuilt installer opens the real app (not the
  license tool) on a clean install; a payment can be scoped to one
  invoice; a customer's combined monthly installment total displays
  correctly; updating an existing install preserves its database and
  activated license. All met.

## Post-Phase-8 updates (not in the original plan) — ✅ Complete

Added 2026-09-05, per direct request:
- **Daily-collection sales (v1.2.1)**: a `CreditSale` can now space its
  installment schedule by day instead of always by calendar month —
  `credit_sale.installment_period_unit` (migration `0006`, `'months'` or
  `'days'`, default `'months'`), resolved by `engine::generate_schedule`
  which now takes a `PeriodUnit` and advances due dates by day or by
  month accordingly. `agreed_months` keeps its name and still holds the
  installment *count* regardless of unit — renaming it would have
  touched every DTO/query for no behavioral gain. The New Sale form gained
  a أشهر/أيام selector next to the installment-count field (defaulting to
  أشهر, the original behavior); the customer detail page's combined
  recurring-installment total is now reported separately per unit
  (monthly vs. daily), since the two aren't the same kind of recurring
  cost and were never meant to be summed together.
- **Exit criteria:** a sale created with the "أيام" unit produces
  installments due one day apart instead of one month apart, sums
  exactly to the total (remainder still folds into the last installment),
  and round-trips correctly through `get_sales_for_customer`. All met —
  covered by new Rust unit/integration tests
  (`engine::tests::schedule_with_days_unit_spaces_installments_one_day_apart`,
  `repo::sale::tests::create_sale_with_days_period_unit_spaces_installments_daily`,
  `repo::sale::tests::rejects_invalid_period_unit`).
