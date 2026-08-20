use tauri::State;

use crate::db::DbState;
use crate::models::{CreateGuarantorPayload, GuarantorDto};
use crate::repo;

#[tauri::command]
pub fn create_guarantor(state: State<DbState>, payload: CreateGuarantorPayload) -> Result<GuarantorDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::guarantor::create_guarantor(&conn, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_guarantors(state: State<DbState>, search_term: Option<String>) -> Result<Vec<GuarantorDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::guarantor::get_guarantors(&conn, search_term.as_deref()).map_err(|e| e.to_string())
}
