use tauri::State;

use crate::db::DbState;
use crate::models::{CreatePaymentPayload, PaymentDto};
use crate::repo;

#[tauri::command]
pub fn register_payment(state: State<DbState>, payload: CreatePaymentPayload) -> Result<PaymentDto, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::payment::register_payment(&mut conn, payload)
}
