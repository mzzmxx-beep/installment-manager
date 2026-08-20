use rusqlite::{params, Connection};

use crate::audit;
use crate::models::{CreateProductPayload, ProductDto};

fn row_to_dto(row: &rusqlite::Row) -> rusqlite::Result<ProductDto> {
    Ok(ProductDto {
        id: row.get("id")?,
        name: row.get("name")?,
        reference_cash_price: row.get("reference_cash_price")?,
        currency_code: row.get("currency_code")?,
        is_active: row.get::<_, i64>("is_active")? != 0,
    })
}

pub fn create_product(conn: &Connection, payload: CreateProductPayload) -> rusqlite::Result<ProductDto> {
    conn.execute(
        "INSERT INTO product (name, reference_cash_price, currency_code) VALUES (?1, ?2, ?3)",
        params![payload.name, payload.reference_cash_price, payload.currency_code],
    )?;
    let id = conn.last_insert_rowid();

    let dto = conn.query_row(
        "SELECT id, name, reference_cash_price, currency_code, is_active FROM product WHERE id = ?1",
        params![id],
        row_to_dto,
    )?;
    audit::log_insert(conn, "product", id, &dto);
    Ok(dto)
}

pub fn get_active_products(conn: &Connection) -> rusqlite::Result<Vec<ProductDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, reference_cash_price, currency_code, is_active
         FROM product
         WHERE is_active = 1
         ORDER BY name",
    )?;
    let rows = stmt.query_map([], row_to_dto)?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;

    #[test]
    fn create_then_list_round_trip() {
        let conn = init_test_db();

        let created = create_product(
            &conn,
            CreateProductPayload {
                name: "Samsung TV 55\"".into(),
                reference_cash_price: 500_000,
                currency_code: "IQD".into(),
            },
        )
        .expect("create_product should succeed");

        assert!(created.is_active);

        let all = get_active_products(&conn).expect("get_active_products should succeed");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, created.id);
    }
}
