use tauri::State;

use crate::db::DbState;
use crate::models::{CustomerConversionSummaryDto, PaymentConversionDto, ProductConversionSummaryDto, SaleConversionDto};
use crate::repo;

/// Tauri Command: per-invoice currency-conversion detail (only items whose
/// product currency differs from the sale's currency), optionally scoped to
/// a `[from_date, to_date]` range.
#[tauri::command]
pub fn get_sale_conversions(
    state: State<DbState>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<SaleConversionDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::currency_report::get_sale_conversions(&conn, from_date.as_deref(), to_date.as_deref())
}

/// Tauri Command: every payment that was converted into another currency
/// during allocation, optionally scoped to a `[from_date, to_date]` range.
#[tauri::command]
pub fn get_payment_conversions(
    state: State<DbState>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<PaymentConversionDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::currency_report::get_payment_conversions(&conn, from_date.as_deref(), to_date.as_deref())
}

/// Tauri Command: per-product (device) rollup of every currency conversion
/// it was part of.
#[tauri::command]
pub fn get_product_conversion_summary(state: State<DbState>) -> Result<Vec<ProductConversionSummaryDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::currency_report::get_product_conversion_summary(&conn)
}

/// Tauri Command: per-customer rollup combining both their sale-item and
/// payment currency conversions.
#[tauri::command]
pub fn get_customer_conversion_summary(state: State<DbState>) -> Result<Vec<CustomerConversionSummaryDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::currency_report::get_customer_conversion_summary(&conn)
}
