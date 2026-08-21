use tauri::State;

use crate::db::DbState;
use crate::models::{CustomerStatementDto, OverdueInstallmentDto};
use crate::repo;

/// Tauri Command: full transaction history and derived balance for one customer.
#[tauri::command]
pub fn get_customer_statement(state: State<DbState>, customer_id: i64) -> Result<CustomerStatementDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::reporting::get_customer_statement(&conn, customer_id)
}

/// Tauri Command: every installment overdue as of `current_date` (`YYYY-MM-DD`),
/// across all customers, most-overdue-first.
#[tauri::command]
pub fn get_overdue_installments(state: State<DbState>, current_date: String) -> Result<Vec<OverdueInstallmentDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::reporting::get_overdue_installments(&conn, &current_date)
}
