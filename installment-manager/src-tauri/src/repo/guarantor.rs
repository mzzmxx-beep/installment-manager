use rusqlite::{params, Connection};

use crate::audit;
use crate::models::{CreateGuarantorPayload, GuarantorDto};

fn row_to_dto(row: &rusqlite::Row) -> rusqlite::Result<GuarantorDto> {
    Ok(GuarantorDto {
        id: row.get("id")?,
        name: row.get("name")?,
        phone: row.get("phone")?,
        national_id: row.get("national_id")?,
        address: row.get("address")?,
        created_at: row.get("created_at")?,
    })
}

pub fn create_guarantor(
    conn: &Connection,
    payload: CreateGuarantorPayload,
) -> rusqlite::Result<GuarantorDto> {
    conn.execute(
        "INSERT INTO guarantor (name, phone, national_id, address) VALUES (?1, ?2, ?3, ?4)",
        params![
            payload.name,
            payload.phone,
            payload.national_id,
            payload.address
        ],
    )?;
    let id = conn.last_insert_rowid();

    let dto = conn.query_row(
        "SELECT id, name, phone, national_id, address, created_at FROM guarantor WHERE id = ?1",
        params![id],
        row_to_dto,
    )?;
    audit::log_insert(conn, "guarantor", id, &dto);
    Ok(dto)
}

pub fn get_guarantors(
    conn: &Connection,
    search_term: Option<&str>,
) -> rusqlite::Result<Vec<GuarantorDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, phone, national_id, address, created_at
         FROM guarantor
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

        let created = create_guarantor(
            &conn,
            CreateGuarantorPayload {
                name: "Sara Kareem".into(),
                phone: None,
                national_id: "NID-G001".into(),
                address: None,
            },
        )
        .expect("create_guarantor should succeed");

        assert!(created.id > 0);

        let all = get_guarantors(&conn, None).expect("get_guarantors should succeed");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
    }
}
