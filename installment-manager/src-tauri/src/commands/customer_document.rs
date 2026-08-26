use tauri::State;

use crate::db::DbState;
use crate::models::{AddCustomerDocumentPayload, CustomerDocumentDto, CustomerDocumentMetaDto};
use crate::repo;

/// Tauri Command: uploads a new customer document photo.
#[tauri::command]
pub fn add_customer_document(
    state: State<DbState>,
    payload: AddCustomerDocumentPayload,
) -> Result<CustomerDocumentMetaDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::customer_document::add_customer_document(&conn, payload)
}

/// Tauri Command: lists a customer's document photos, content included.
#[tauri::command]
pub fn get_customer_documents(state: State<DbState>, customer_id: i64) -> Result<Vec<CustomerDocumentDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::customer_document::get_customer_documents(&conn, customer_id)
}

/// Tauri Command: deletes a customer document photo.
#[tauri::command]
pub fn delete_customer_document(state: State<DbState>, document_id: i64) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::customer_document::delete_customer_document(&conn, document_id)
}
