use tauri::State;

use crate::db::DbState;
use crate::repo;

/// Tauri Command: writes a full, consistent copy of the live database to
/// `destination_path` (chosen client-side via the native save dialog — this
/// command only ever receives a path the user already picked, local disk or
/// any synced folder like OneDrive/Google Drive).
#[tauri::command]
pub fn backup_database(state: State<DbState>, destination_path: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    repo::backup::backup_database(&conn, &destination_path)
}

/// Tauri Command: best-effort detection of the user's local OneDrive sync
/// folder (Windows sets the `OneDrive` env var automatically once it's
/// installed) — used only to pre-fill the backup save dialog's starting
/// folder, never assumed to exist. Google Drive has no equivalent env var
/// (it mounts as its own drive letter via Google Drive for Desktop), so
/// there's nothing reliable to detect for it — the user browses to it
/// manually in the same save dialog instead.
#[tauri::command]
pub fn get_onedrive_dir() -> Option<String> {
    let path = std::env::var("OneDrive").ok()?;
    if std::path::Path::new(&path).is_dir() {
        Some(path)
    } else {
        None
    }
}
