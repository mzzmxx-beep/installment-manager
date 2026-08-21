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
    pub sale_date: String,
    pub agreed_months: i32,
    pub applied_markup_value: i64,
    pub total_installment_price: i64,
    pub currency_code: String,
    pub manual_exchange_rate_micros: i64,
    pub created_at: String,
    pub items: Vec<CreditSaleItemDto>,
    pub installments: Vec<InstallmentDto>,
}

/// Request DTO for registering a Payment. Allocation is automatic
/// (oldest-due-installment-first, ARCHITECTURE.md §4) — the caller does
/// not pick which installment(s) the payment applies to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePaymentPayload {
    pub customer_id: i64,
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
    },
    Expired {
        customer_name: String,
        expires_at: String,
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
