use tauri::State;

use crate::db::DbState;
use crate::models::{CreateCustomerPayload, CustomerDto};
use crate::repo;

/// Tauri Command: creates a new Customer.
///
/// Thin IPC wrapper over `repo::customer::create_customer` (ARCHITECTURE.md §3) —
/// no SQL and no business logic live here.
#[tauri::command]
pub fn create_customer(
    state: State<DbState>,
    payload: CreateCustomerPayload,
) -> Result<CustomerDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::customer::create_customer(&conn, payload).map_err(|e| e.to_string())
}

/// Tauri Command: lists Customers, optionally filtered by a search term
/// matched against name or national_id.
#[tauri::command]
pub fn get_customers(
    state: State<DbState>,
    search_term: Option<String>,
) -> Result<Vec<CustomerDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::customer::get_customers(&conn, search_term.as_deref()).map_err(|e| e.to_string())
}
