use rusqlite::{params, Connection};

use crate::audit;
use crate::models::{CreateCustomerPayload, CustomerDto};

fn row_to_dto(row: &rusqlite::Row) -> rusqlite::Result<CustomerDto> {
    Ok(CustomerDto {
        id: row.get("id")?,
        name: row.get("name")?,
        phone: row.get("phone")?,
        national_id: row.get("national_id")?,
        address: row.get("address")?,
        created_at: row.get("created_at")?,
    })
}

pub fn create_customer(
    conn: &Connection,
    payload: CreateCustomerPayload,
) -> rusqlite::Result<CustomerDto> {
    conn.execute(
        "INSERT INTO customer (name, phone, national_id, address) VALUES (?1, ?2, ?3, ?4)",
        params![
            payload.name,
            payload.phone,
            payload.national_id,
            payload.address
        ],
    )?;
    let id = conn.last_insert_rowid();

    let dto = conn.query_row(
        "SELECT id, name, phone, national_id, address, created_at FROM customer WHERE id = ?1",
        params![id],
        row_to_dto,
    )?;
    audit::log_insert(conn, "customer", id, &dto);
    Ok(dto)
}

pub fn get_customers(
    conn: &Connection,
    search_term: Option<&str>,
) -> rusqlite::Result<Vec<CustomerDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, phone, national_id, address, created_at
         FROM customer
         WHERE ?1 IS NULL OR name LIKE '%' || ?1 || '%' OR national_id LIKE '%' || ?1 || '%'
         ORDER BY name",
    )?;
    let rows = stmt.query_map(params![search_term], row_to_dto)?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;

    #[test]
    fn create_then_list_round_trip() {
        let conn = init_test_db();

        let created = create_customer(
            &conn,
            CreateCustomerPayload {
                name: "Ahmed Ali".into(),
                phone: Some("07700000000".into()),
                national_id: "NID-001".into(),
                address: Some("Baghdad".into()),
            },
        )
        .expect("create_customer should succeed");

        assert_eq!(created.name, "Ahmed Ali");
        assert_eq!(created.national_id, "NID-001");
        assert!(created.id > 0);

        let all = get_customers(&conn, None).expect("get_customers should succeed");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);

        let found = get_customers(&conn, Some("Ahmed")).expect("search should succeed");
        assert_eq!(found.len(), 1);

        let missing = get_customers(&conn, Some("Nobody")).expect("search should succeed");
        assert!(missing.is_empty());
    }

    #[test]
    fn duplicate_national_id_is_rejected() {
        let conn = init_test_db();

        create_customer(
            &conn,
            CreateCustomerPayload {
                name: "First".into(),
                phone: None,
                national_id: "NID-DUP".into(),
                address: None,
            },
        )
        .expect("first insert should succeed");

        let result = create_customer(
            &conn,
            CreateCustomerPayload {
                name: "Second".into(),
                phone: None,
                national_id: "NID-DUP".into(),
                address: None,
            },
        );

        assert!(result.is_err(), "duplicate national_id must be rejected");
    }
}
