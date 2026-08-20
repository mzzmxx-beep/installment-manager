use tauri::State;

use crate::db::DbState;
use crate::models::{CreateProductPayload, ProductDto};
use crate::repo;

#[tauri::command]
pub fn create_product(state: State<DbState>, payload: CreateProductPayload) -> Result<ProductDto, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::product::create_product(&conn, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_products(state: State<DbState>) -> Result<Vec<ProductDto>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::product::get_active_products(&conn).map_err(|e| e.to_string())
}
