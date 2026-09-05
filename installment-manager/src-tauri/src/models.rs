use serde::{Deserialize, Serialize};

/// Typed response DTO for a Customer row. This is the only shape of
/// customer data that ever crosses the Tauri IPC boundary (ARCHITECTURE.md §3) —
/// no raw `rusqlite::Row` ever reaches the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerDto {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub national_id: String,
    pub address: Option<String>,
    pub created_at: String,
}

/// Request DTO for creating a new Customer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCustomerPayload {
    pub name: String,
    pub phone: Option<String>,
    pub national_id: String,
    pub address: Option<String>,
}

/// Typed response DTO for a Product row. `reference_cash_price` is a
/// template only (ARCHITECTURE.md §8) — never used to redisplay a
/// historical sale's price.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductDto {
    pub id: i64,
    pub name: String,
    pub reference_cash_price: i64,
    pub currency_code: String,
    pub is_active: bool,
}

/// Request DTO for creating a new Product.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProductPayload {
    pub name: String,
    pub reference_cash_price: i64,
    pub currency_code: String,
}

/// How a manually-entered markup should be interpreted. `Percentage`
/// values are basis points (1/100 of a percent), e.g. `1000` = 10.00%, so
/// the resolution stays integer-only (ARCHITECTURE.md §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkupType {
    Flat,
    Percentage,
}

/// One line item requested when creating a sale: a product and quantity.
/// The cash price is snapshotted server-side from the `Product` row at
/// creation time — the frontend never supplies a price here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSaleItemInput {
    pub product_id: i64,
    pub quantity: i64,
}

/// Typed response DTO for a CreditSaleItem row, denormalized with the
/// product name for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSaleItemDto {
    pub id: i64,
    pub sale_id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub snapshot_cash_price: i64,
    pub quantity: i64,
}

/// Typed response DTO for an Installment row. `allocated_amount` and
/// `remaining_amount` are always derived from `PaymentAllocation`
/// (ARCHITECTURE.md §8) — there is no stored balance column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallmentDto {
    pub id: i64,
    pub sale_id: i64,
    pub due_date: String,
    pub scheduled_amount: i64,
    pub allocated_amount: i64,
    pub remaining_amount: i64,
    pub status: String,
}

/// Request DTO for creating a new CreditSale. Markup, months, and exchange
/// rate are all manual, per-transaction inputs (ARCHITECTURE.md §5) —
/// there is no global config this reads from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCreditSalePayload {
    pub customer_id: i64,
    /// An existing customer vouching for this sale, if any — a guarantor is
    /// not a separate entity, just another `Customer` row (must differ from
    /// `customer_id`).
    pub guarantor_id: Option<i64>,
    pub sale_date: String,
    pub items: Vec<CreditSaleItemInput>,
    pub markup_type: MarkupType,
    pub markup_input: i64,
    pub agreed_months: i32,
    /// How `agreed_months` is spaced into due dates: `"months"` (one
    /// calendar month apart, the original behavior) or `"days"` (one day
    /// apart, for daily-collection sales). Plain `String` rather than a Rust
    /// enum, same convention as `currency_code` — validated against the
    /// DB's own CHECK constraint (ARCHITECTURE.md §8).
    pub installment_period_unit: String,
    pub currency_code: String,
    pub manual_exchange_rate_micros: i64,
}

/// Typed response DTO for a CreditSale, with its items and generated
/// installment schedule inlined — the immutable snapshot in full
/// (ARCHITECTURE.md §8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSaleDto {
    pub id: i64,
    pub customer_id: i64,
    pub guarantor_id: Option<i64>,
    /// Denormalized from `Customer.name` at read time for display — the
    /// guarantor is just another `Customer` row (ARCHITECTURE.md §8), so
    /// this is never stored, only joined in.
    pub guarantor_name: Option<String>,
    pub sale_date: String,
    pub agreed_months: i32,
    /// See `CreateCreditSalePayload::installment_period_unit`.
    pub installment_period_unit: String,
    pub applied_markup_value: i64,
    pub total_installment_price: i64,
    pub currency_code: String,
    pub manual_exchange_rate_micros: i64,
    pub created_at: String,
    pub items: Vec<CreditSaleItemDto>,
    pub installments: Vec<InstallmentDto>,
}

/// Request DTO for registering a Payment. Allocation is automatic
/// (oldest-due-installment-first, ARCHITECTURE.md §4) across the customer's
/// outstanding installments — unless `sale_id` narrows it to one invoice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePaymentPayload {
    pub customer_id: i64,
    /// Optional: scope allocation to this one CreditSale's outstanding
    /// installments only. `None` keeps the default cross-sale behavior.
    pub sale_id: Option<i64>,
    pub payment_date: String,
    pub amount_paid: i64,
    pub currency_code: String,
    pub manual_exchange_rate_micros: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentAllocationDto {
    pub id: i64,
    pub payment_id: i64,
    pub installment_id: i64,
    pub allocated_amount: i64,
}

/// Typed response DTO for a Payment, with the allocations it produced.
/// `unallocated_amount` surfaces any leftover the customer's outstanding
/// installments couldn't absorb, instead of silently dropping it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentDto {
    pub id: i64,
    pub customer_id: i64,
    pub payment_date: String,
    pub amount_paid: i64,
    pub currency_code: String,
    pub manual_exchange_rate_micros: i64,
    pub created_at: String,
    pub allocations: Vec<PaymentAllocationDto>,
    pub unallocated_amount: i64,
}

/// Typed response DTO for a CustomerDocument row (a "مستمسك" photo — ID
/// card, contract page, etc.), content included as base64 for the IPC
/// boundary (ARCHITECTURE.md §3 — no raw bytes/paths cross it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerDocumentDto {
    pub id: i64,
    pub customer_id: i64,
    pub file_name: String,
    pub mime_type: String,
    pub created_at: String,
    pub content_base64: String,
}

/// Metadata-only shape of a CustomerDocument (no content) — used as the
/// response for add/delete and for the audit log, so a document's image
/// bytes are never duplicated into `audit_log`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerDocumentMetaDto {
    pub id: i64,
    pub customer_id: i64,
    pub file_name: String,
    pub mime_type: String,
    pub created_at: String,
}

/// Request DTO for uploading a new CustomerDocument.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddCustomerDocumentPayload {
    pub customer_id: i64,
    pub file_name: String,
    pub mime_type: String,
    pub content_base64: String,
}

/// Request DTO for activating a license (ARCHITECTURE.md §7).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivateLicensePayload {
    pub license_key: String,
}

/// Result of checking or activating a license — the frontend gates the
/// entire app on this (only `Valid` allows normal use).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state")]
pub enum LicenseStatus {
    NotActivated,
    Valid {
        customer_name: String,
        expires_at: Option<String>,
        /// Date the vendor issued this license (from the signed payload) —
        /// for a free trial (no vendor payload involved) this is the same
        /// as `activated_at`'s date.
        issued_at: String,
        /// When this license was activated on *this* machine (may be later
        /// than `issued_at` if the customer didn't activate immediately).
        activated_at: String,
        /// True for a self-service free trial (see `is_trial` below).
        is_trial: bool,
    },
    Expired {
        customer_name: String,
        expires_at: String,
        is_trial: bool,
    },
    /// Covers a malformed/unsigned key, a signature that doesn't match the
    /// embedded public key, or a HWID that doesn't match the one this
    /// license was activated against.
    Invalid {
        reason: String,
    },
    /// The OS clock is behind the last recorded successful run — refuses
    /// to proceed regardless of an otherwise-valid license (ARCHITECTURE.md §7).
    ClockRollbackDetected,
}

/// Total outstanding balance in one currency — a customer can owe in both
/// at once, so this is never collapsed into a single number.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrencyBalanceDto {
    pub currency_code: String,
    pub total_remaining: i64,
}

/// Full transaction history and derived balance for one customer
/// (ARCHITECTURE.md §4) — every sale and every payment they've ever made,
/// plus the outstanding balance per currency. Balances are always derived
/// from `Installment`/`PaymentAllocation` at query time, never read from a
/// cached column (ARCHITECTURE.md §8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerStatementDto {
    pub customer: CustomerDto,
    pub sales: Vec<CreditSaleDto>,
    pub payments: Vec<PaymentDto>,
    pub balances: Vec<CurrencyBalanceDto>,
}

/// One overdue installment for the overdue dashboard (ARCHITECTURE.md §4):
/// `due_date < current_date` and still short of `scheduled_amount`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverdueInstallmentDto {
    pub installment_id: i64,
    pub sale_id: i64,
    pub customer_id: i64,
    pub customer_name: String,
    pub due_date: String,
    pub days_overdue: i64,
    pub currency_code: String,
    pub scheduled_amount: i64,
    pub remaining_amount: i64,
}

/// A monetary amount in one currency — the generic building block for
/// analytics aggregates, which can span both currencies at once and are
/// therefore never collapsed into a single number.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrencyAmountDto {
    pub currency_code: String,
    pub amount: i64,
}

/// Sales and profit totals for one currency over an optional date range.
/// `total_markup` is the profit (cash price + markup = installment price,
/// so markup is exactly the margin); `total_collected`/`total_outstanding`
/// reflect what's been paid so far on sales made in the period, regardless
/// of when the payment itself landed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesSummaryDto {
    pub currency_code: String,
    pub sale_count: i64,
    pub total_cash_value: i64,
    pub total_markup: i64,
    pub total_installment_value: i64,
    pub total_collected: i64,
    pub total_outstanding: i64,
}

/// One product's sales ranking: units moved and revenue (cash value sold,
/// not counting markup, which is a sale-level not item-level figure).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSalesDto {
    pub product_id: i64,
    pub product_name: String,
    pub total_quantity: i64,
    pub revenue_by_currency: Vec<CurrencyAmountDto>,
}

/// One customer's ranking by number of completed sales.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerRankingDto {
    pub customer_id: i64,
    pub customer_name: String,
    pub sale_count: i64,
    pub total_purchased_by_currency: Vec<CurrencyAmountDto>,
}

/// One customer's overdue standing, aggregated across every overdue
/// installment they have (possibly spanning both currencies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerOverdueRankingDto {
    pub customer_id: i64,
    pub customer_name: String,
    pub overdue_installment_count: i64,
    pub max_days_overdue: i64,
    pub overdue_amount_by_currency: Vec<CurrencyAmountDto>,
}

/// One row of the all-customers overview: activity and standing summary,
/// complementing the single-customer statement (`CustomerStatementDto`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerOverviewDto {
    pub customer_id: i64,
    pub customer_name: String,
    pub sale_count: i64,
    pub total_purchased_by_currency: Vec<CurrencyAmountDto>,
    pub total_remaining_by_currency: Vec<CurrencyAmountDto>,
    pub last_sale_date: Option<String>,
}

/// One sale item whose product currency differs from its sale's currency —
/// i.e. it was actually run through `engine::convert_currency` at sale time.
/// `original_unit_price` is *not* a stored value (`credit_sale_item` has no
/// such column) — it's reconstructed by inverse-converting the stored
/// `snapshot_cash_price` back through the same rate, which is exact as long
/// as the product's currency hasn't changed since the sale (there is no
/// edit-product command, so this holds for every sale today).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaleConversionItemDto {
    pub product_id: i64,
    pub product_name: String,
    pub original_currency: String,
    pub original_unit_price: i64,
    pub converted_currency: String,
    pub converted_unit_price: i64,
    pub quantity: i64,
    pub exchange_rate_micros: i64,
}

/// One invoice's currency-conversion detail: only the items that actually
/// crossed a currency boundary are included (a same-currency item never
/// went through `convert_currency`, so it has nothing to explain).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaleConversionDto {
    pub sale_id: i64,
    pub sale_date: String,
    pub customer_id: i64,
    pub customer_name: String,
    pub sale_currency: String,
    pub items: Vec<SaleConversionItemDto>,
}

/// One payment whose currency differed from at least one installment it
/// paid into, so part (or all) of it was converted by
/// `engine::allocate_payment`. `converted_by_currency` is how much landed
/// in each *other* currency — a payment can span both currencies if it was
/// large enough to spill from one sale's installments into another's.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentConversionDto {
    pub payment_id: i64,
    pub payment_date: String,
    pub customer_id: i64,
    pub customer_name: String,
    pub payment_currency: String,
    pub amount_paid: i64,
    pub exchange_rate_micros: i64,
    pub converted_by_currency: Vec<CurrencyAmountDto>,
}

/// Per-product rollup of every sale-item conversion involving that product
/// (device) — how many times it was sold in a currency other than its own,
/// and the total value on each side of the conversion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductConversionSummaryDto {
    pub product_id: i64,
    pub product_name: String,
    pub conversion_count: i64,
    pub original_value_by_currency: Vec<CurrencyAmountDto>,
    pub converted_value_by_currency: Vec<CurrencyAmountDto>,
}

/// Per-customer rollup of both conversion sources (sale items and
/// payments), so "how much currency conversion touched this customer" has
/// one answer instead of two separate reports to cross-reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerConversionSummaryDto {
    pub customer_id: i64,
    pub customer_name: String,
    pub item_conversion_count: i64,
    pub item_original_value_by_currency: Vec<CurrencyAmountDto>,
    pub item_converted_value_by_currency: Vec<CurrencyAmountDto>,
    pub payment_conversion_count: i64,
    pub payment_converted_value_by_currency: Vec<CurrencyAmountDto>,
}
