//! Every mutating action writes an `AuditLog` entry (ARCHITECTURE.md §6).
//! This is the single insertion point so repo functions don't hand-roll SQL
//! for it individually.

use rusqlite::{params, Connection};
use serde::Serialize;

pub fn log_insert(conn: &Connection, table_name: &str, record_id: i64, payload: &impl Serialize) {
    let json = serde_json::to_string(payload).unwrap_or_default();
    let _ = conn.execute(
        "INSERT INTO audit_log (table_name, record_id, action, new_payload) VALUES (?1, ?2, 'INSERT', ?3)",
        params![table_name, record_id, json],
    );
}

pub fn log_update(
    conn: &Connection,
    table_name: &str,
    record_id: i64,
    old_payload: &impl Serialize,
    new_payload: &impl Serialize,
) {
    let old_json = serde_json::to_string(old_payload).unwrap_or_default();
    let new_json = serde_json::to_string(new_payload).unwrap_or_default();
    let _ = conn.execute(
        "INSERT INTO audit_log (table_name, record_id, action, old_payload, new_payload) VALUES (?1, ?2, 'UPDATE', ?3, ?4)",
        params![table_name, record_id, old_json, new_json],
    );
}

pub fn log_delete(conn: &Connection, table_name: &str, record_id: i64, old_payload: &impl Serialize) {
    let old_json = serde_json::to_string(old_payload).unwrap_or_default();
    let _ = conn.execute(
        "INSERT INTO audit_log (table_name, record_id, action, old_payload) VALUES (?1, ?2, 'DELETE', ?3)",
        params![table_name, record_id, old_json],
    );
}
