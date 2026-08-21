use tauri::State;

use crate::db::DbState;
use crate::models::{ActivateLicensePayload, LicenseStatus};
use crate::repo;

/// Tauri Command: re-checks the currently activated license (signature,
/// HWID binding, expiry, clock rollback). Called on app startup to decide
/// whether to show the normal app or a lockdown/activation screen.
#[tauri::command]
pub fn validate_license(state: State<DbState>) -> Result<LicenseStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::license::validate_license(&conn).map_err(|e| e.to_string())
}

/// Tauri Command: activates a new license key entered by the user.
#[tauri::command]
pub fn activate_license(state: State<DbState>, payload: ActivateLicensePayload) -> Result<LicenseStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::license::activate_license(&conn, &payload.license_key).map_err(|e| e.to_string())
}
