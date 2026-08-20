use std::sync::Mutex;

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use tauri::Manager;

/// Tauri-managed state wrapping the single SQLite connection.
///
/// SQLite only ever allows one writer at a time, so a `Mutex<Connection>`
/// (rather than a connection pool) is the correct model here: it makes the
/// single-writer constraint explicit instead of hiding it behind a pool
/// that would just serialize writes anyway.
pub struct DbState(pub Mutex<Connection>);

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(include_str!("../migrations/0001_init.sql"))])
}

/// Opens (creating if needed) the SQLite database file in the app's local
/// data directory, applies any pending migrations, and returns a ready
/// connection.
pub fn init_db(app: &tauri::App) -> rusqlite::Result<Connection> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .expect("app local data dir must be resolvable");
    std::fs::create_dir_all(&data_dir).expect("failed to create app local data dir");

    let db_path = data_dir.join("installment_manager.sqlite3");
    let mut conn = Connection::open(db_path)?;

    conn.pragma_update(None, "foreign_keys", "ON")?;

    migrations()
        .to_latest(&mut conn)
        .expect("failed to apply database migrations");

    Ok(conn)
}

#[cfg(test)]
/// Opens an in-memory database with migrations applied, for use in unit tests.
pub fn init_test_db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations()
        .to_latest(&mut conn)
        .expect("failed to apply migrations to in-memory db");
    conn
}
