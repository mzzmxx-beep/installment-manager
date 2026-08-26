use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::Connection;

/// Copies the live database to `destination` using SQLite's Online Backup
/// API rather than a raw file copy — this produces a consistent snapshot
/// even while `conn` has pages cached or a transaction structure in flight,
/// which a plain `std::fs::copy` of the `.sqlite3` file could not guarantee.
pub fn backup_database(conn: &Connection, destination: &str) -> Result<(), String> {
    let mut dst = Connection::open(destination).map_err(|e| e.to_string())?;
    let backup = Backup::new(conn, &mut dst).map_err(|e| e.to_string())?;
    // 5 pages per step with a short pause keeps the source connection's lock
    // brief and non-blocking rather than holding it for one giant copy.
    backup
        .run_to_completion(5, Duration::from_millis(50), None)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::{CreateCustomerPayload, CreateProductPayload};
    use crate::repo;

    #[test]
    fn backup_produces_a_queryable_copy_with_the_same_data() {
        let conn = init_test_db();
        repo::customer::create_customer(
            &conn,
            CreateCustomerPayload { name: "Backup Test".into(), phone: None, national_id: "NID-BK1".into(), address: None },
        )
        .unwrap();
        repo::product::create_product(
            &conn,
            CreateProductPayload { name: "Item".into(), reference_cash_price: 1_000, currency_code: "IQD".into() },
        )
        .unwrap();

        let dest = std::env::temp_dir().join(format!("installment_manager_backup_test_{}.sqlite3", std::process::id()));
        let dest_str = dest.to_str().unwrap();

        backup_database(&conn, dest_str).expect("backup should succeed");

        let restored = Connection::open(dest_str).unwrap();
        let customer_count: i64 = restored.query_row("SELECT COUNT(*) FROM customer", [], |r| r.get(0)).unwrap();
        assert_eq!(customer_count, 1);
        let product_count: i64 = restored.query_row("SELECT COUNT(*) FROM product", [], |r| r.get(0)).unwrap();
        assert_eq!(product_count, 1);

        drop(restored);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn backup_to_an_unwritable_path_is_an_error() {
        let conn = init_test_db();
        let result = backup_database(&conn, "Z:\\definitely\\not\\a\\real\\path\\backup.sqlite3");
        assert!(result.is_err());
    }
}
