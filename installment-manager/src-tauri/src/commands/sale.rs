use tauri::State;

use crate::db::DbState;
use crate::models::{CreateCreditSalePayload, CreditSaleDto};
use crate::repo;

#[tauri::command]
pub fn create_credit_sale(state: State<DbState>, payload: CreateCreditSalePayload) -> Result<CreditSaleDto, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::sale::create_credit_sale(&mut conn, payload)
}

#[tauri::command]
pub fn get_sales_for_customer(state: State<DbState>, customer_id: i64) -> Result<Vec<CreditSaleDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::sale::get_sales_for_customer(&conn, customer_id).map_err(|e| e.to_string())
}
