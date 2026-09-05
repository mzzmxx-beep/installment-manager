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
    Migrations::new(vec![
        M::up(include_str!("../migrations/0001_init.sql")),
        M::up(include_str!("../migrations/0002_guarantor_is_a_customer.sql")),
        M::up(include_str!("../migrations/0003_license_activation.sql")),
        M::up(include_str!("../migrations/0004_customer_document.sql")),
        M::up(include_str!("../migrations/0005_trial_license.sql")),
        M::up(include_str!("../migrations/0006_installment_period_unit.sql")),
    ])
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

    // This bundled SQLite defaults `foreign_keys` to ON. A migration that
    // rebuilds a table (create-copy-drop-rename, needed whenever a
    // REFERENCES target changes — SQLite has no ALTER for that) has its
    // DROP TABLE step rejected as soon as another table holds a live
    // FK-referencing row. PRAGMA foreign_keys cannot be toggled mid-
    // transaction, and to_latest() runs each migration in its own
    // transaction, so it must be turned off here first and back on only
    // once every migration has landed.
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    migrations()
        .to_latest(&mut conn)
        .expect("failed to apply database migrations");
    conn.pragma_update(None, "foreign_keys", "ON")?;

    Ok(conn)
}

#[cfg(test)]
/// Opens an in-memory database with migrations applied, for use in unit tests.
pub fn init_test_db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    migrations()
        .to_latest(&mut conn)
        .expect("failed to apply migrations to in-memory db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for a real failure: applying 0002 against a database
    /// that already has 0001-era data (a live install, not a fresh one)
    /// used to fail with a FOREIGN KEY constraint error, because
    /// credit_sale_item/installment rows still pointed at the credit_sale
    /// row 0002 needs to drop and rebuild. `init_test_db` alone can't catch
    /// this since it always applies every migration to an empty database.
    #[test]
    fn migration_0002_succeeds_against_a_database_with_existing_child_rows() {
        // Mirrors `init_db`'s real ordering: foreign_keys forced off (this
        // bundled SQLite defaults it to ON) until every migration has landed.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        Migrations::new(vec![M::up(include_str!("../migrations/0001_init.sql"))])
            .to_latest(&mut conn)
            .unwrap();

        conn.execute_batch(
            "INSERT INTO customer (id, name, national_id) VALUES (1, 'Customer', 'NID-1');
             INSERT INTO guarantor (id, name, national_id) VALUES (1, 'Old Guarantor', 'NID-G1');
             INSERT INTO product (id, name, reference_cash_price, currency_code) VALUES (1, 'Product', 1000, 'IQD');
             INSERT INTO credit_sale (
                 id, customer_id, guarantor_id, sale_date, agreed_months, applied_markup_value,
                 total_installment_price, currency_code, manual_exchange_rate_micros
             ) VALUES (1, 1, 1, '2026-01-01', 1, 0, 1000, 'IQD', 1000000);
             INSERT INTO credit_sale_item (id, sale_id, product_id, snapshot_cash_price, quantity)
                 VALUES (1, 1, 1, 1000, 1);
             INSERT INTO installment (id, sale_id, due_date, scheduled_amount) VALUES (1, 1, '2026-02-01', 1000);",
        )
        .unwrap();

        migrations()
            .to_latest(&mut conn)
            .expect("0002 must succeed against a populated database");

        let guarantor_id: Option<i64> = conn
            .query_row("SELECT guarantor_id FROM credit_sale WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(guarantor_id, None, "stale guarantor references are dropped, not guessed at");

        let item_sale_id: i64 = conn
            .query_row("SELECT sale_id FROM credit_sale_item WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(item_sale_id, 1, "child rows still resolve against the rebuilt credit_sale row");

        let installment_sale_id: i64 = conn
            .query_row("SELECT sale_id FROM installment WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(installment_sale_id, 1);

        let guarantor_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'guarantor'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(guarantor_table_exists, 0, "the standalone guarantor table is dropped");
    }
}
