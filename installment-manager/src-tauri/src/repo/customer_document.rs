use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection};

use crate::audit;
use crate::models::{AddCustomerDocumentPayload, CustomerDocumentDto, CustomerDocumentMetaDto};

fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<CustomerDocumentMetaDto> {
    Ok(CustomerDocumentMetaDto {
        id: row.get("id")?,
        customer_id: row.get("customer_id")?,
        file_name: row.get("file_name")?,
        mime_type: row.get("mime_type")?,
        created_at: row.get("created_at")?,
    })
}

/// Stores a new customer document photo. The frontend sends the image as
/// base64 (there is no raw-bytes/file-path IPC in this app, ARCHITECTURE.md §3);
/// it's decoded once here and stored as a BLOB.
pub fn add_customer_document(
    conn: &Connection,
    payload: AddCustomerDocumentPayload,
) -> Result<CustomerDocumentMetaDto, String> {
    let content = B64
        .decode(payload.content_base64.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    if content.is_empty() {
        return Err("uploaded file is empty".into());
    }

    conn.execute(
        "INSERT INTO customer_document (customer_id, file_name, mime_type, content) VALUES (?1, ?2, ?3, ?4)",
        params![payload.customer_id, payload.file_name, payload.mime_type, content],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();

    let dto = conn
        .query_row(
            "SELECT id, customer_id, file_name, mime_type, created_at FROM customer_document WHERE id = ?1",
            params![id],
            row_to_meta,
        )
        .map_err(|e| e.to_string())?;

    audit::log_insert(conn, "customer_document", id, &dto);
    Ok(dto)
}

/// Lists a customer's documents, newest first, content included as base64
/// so the gallery can render every thumbnail in one round trip.
pub fn get_customer_documents(conn: &Connection, customer_id: i64) -> Result<Vec<CustomerDocumentDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, customer_id, file_name, mime_type, content, created_at
             FROM customer_document
             WHERE customer_id = ?1
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![customer_id], |row| {
            let content: Vec<u8> = row.get("content")?;
            Ok(CustomerDocumentDto {
                id: row.get("id")?,
                customer_id: row.get("customer_id")?,
                file_name: row.get("file_name")?,
                mime_type: row.get("mime_type")?,
                created_at: row.get("created_at")?,
                content_base64: B64.encode(content),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Removes a document. Unlike the ledger tables, `customer_document` is not
/// append-only — a mis-uploaded photo is meant to be deletable.
pub fn delete_customer_document(conn: &Connection, document_id: i64) -> Result<(), String> {
    let existing = conn
        .query_row(
            "SELECT id, customer_id, file_name, mime_type, created_at FROM customer_document WHERE id = ?1",
            params![document_id],
            row_to_meta,
        )
        .map_err(|e| format!("document {document_id} not found: {e}"))?;

    conn.execute("DELETE FROM customer_document WHERE id = ?1", params![document_id])
        .map_err(|e| e.to_string())?;
    audit::log_delete(conn, "customer_document", document_id, &existing);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::CreateCustomerPayload;
    use crate::repo;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    fn setup_customer(conn: &Connection) -> i64 {
        repo::customer::create_customer(
            conn,
            CreateCustomerPayload {
                name: "Doc Customer".into(),
                phone: None,
                national_id: "NID-D001".into(),
                address: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn add_then_list_round_trip() {
        let conn = init_test_db();
        let customer_id = setup_customer(&conn);

        let added = add_customer_document(
            &conn,
            AddCustomerDocumentPayload {
                customer_id,
                file_name: "id-front.jpg".into(),
                mime_type: "image/jpeg".into(),
                content_base64: B64.encode(b"fake-jpeg-bytes"),
            },
        )
        .expect("add_customer_document should succeed");
        assert_eq!(added.customer_id, customer_id);

        let docs = get_customer_documents(&conn, customer_id).expect("list should succeed");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id, added.id);
        assert_eq!(B64.decode(&docs[0].content_base64).unwrap(), b"fake-jpeg-bytes");
    }

    #[test]
    fn rejects_invalid_base64() {
        let conn = init_test_db();
        let customer_id = setup_customer(&conn);

        let result = add_customer_document(
            &conn,
            AddCustomerDocumentPayload {
                customer_id,
                file_name: "bad.jpg".into(),
                mime_type: "image/jpeg".into(),
                content_base64: "not-valid-base64!!".into(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn delete_removes_the_document() {
        let conn = init_test_db();
        let customer_id = setup_customer(&conn);
        let added = add_customer_document(
            &conn,
            AddCustomerDocumentPayload {
                customer_id,
                file_name: "id-back.jpg".into(),
                mime_type: "image/jpeg".into(),
                content_base64: B64.encode(b"more-fake-bytes"),
            },
        )
        .unwrap();

        delete_customer_document(&conn, added.id).expect("delete should succeed");
        let docs = get_customer_documents(&conn, customer_id).unwrap();
        assert!(docs.is_empty());
    }

    #[test]
    fn deleting_an_unknown_document_is_an_error() {
        let conn = init_test_db();
        assert!(delete_customer_document(&conn, 999).is_err());
    }
}
