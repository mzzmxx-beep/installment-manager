use tauri::State;

use crate::db::DbState;
use crate::models::{CustomerOverdueRankingDto, CustomerOverviewDto, CustomerRankingDto, ProductSalesDto, SalesSummaryDto};
use crate::repo;

/// Tauri Command: sales/profit totals per currency, optionally scoped to a
/// `[from_date, to_date]` range (either end optional, `YYYY-MM-DD`).
#[tauri::command]
pub fn get_sales_summary(
    state: State<DbState>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<SalesSummaryDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::analytics::get_sales_summary(&conn, from_date.as_deref(), to_date.as_deref())
}

/// Tauri Command: best-selling products by quantity, with revenue per currency.
#[tauri::command]
pub fn get_top_products(state: State<DbState>, limit: i64) -> Result<Vec<ProductSalesDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::analytics::get_top_products(&conn, limit)
}

/// Tauri Command: customers ranked by number of completed sales.
#[tauri::command]
pub fn get_top_customers(state: State<DbState>, limit: i64) -> Result<Vec<CustomerRankingDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::analytics::get_top_customers(&conn, limit)
}

/// Tauri Command: customers ranked by how overdue their oldest unpaid
/// installment is, as of `current_date` (`YYYY-MM-DD`).
#[tauri::command]
pub fn get_most_overdue_customers(
    state: State<DbState>,
    current_date: String,
    limit: i64,
) -> Result<Vec<CustomerOverdueRankingDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::analytics::get_most_overdue_customers(&conn, &current_date, limit)
}

/// Tauri Command: every customer's activity summary (sale count, totals, last sale date).
#[tauri::command]
pub fn get_customers_overview(state: State<DbState>) -> Result<Vec<CustomerOverviewDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::analytics::get_customers_overview(&conn)
}
