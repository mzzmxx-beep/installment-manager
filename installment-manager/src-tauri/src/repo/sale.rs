use chrono::NaiveDate;
use rusqlite::{params, Connection};

use crate::audit;
use crate::engine;
use crate::models::{CreateCreditSalePayload, CreditSaleDto, CreditSaleItemDto, InstallmentDto};

/// Creates a CreditSale and its items/installments inside a single
/// transaction (ARCHITECTURE.md §3, §4): a half-written sale must never be
/// observable, so any failure below rolls the whole thing back.
pub fn create_credit_sale(
    conn: &mut Connection,
    payload: CreateCreditSalePayload,
) -> Result<CreditSaleDto, String> {
    if payload.items.is_empty() {
        return Err("a sale must have at least one item".into());
    }
    if payload.manual_exchange_rate_micros <= 0 {
        return Err("manual_exchange_rate_micros must be positive".into());
    }
    if payload.guarantor_id == Some(payload.customer_id) {
        return Err("a customer cannot guarantee their own sale".into());
    }

    let sale_date = NaiveDate::parse_from_str(&payload.sale_date, "%Y-%m-%d")
        .map_err(|e| format!("invalid sale_date: {e}"))?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut cash_total: i64 = 0;
    // product_id, name, snapshot_cash_price (converted into the sale's own
    // currency), quantity
    let mut item_rows: Vec<(i64, String, i64, i64)> = Vec::new();
    for item in &payload.items {
        if item.quantity <= 0 {
            return Err("item quantity must be positive".into());
        }
        let (name, cash_price, product_currency, is_active): (String, i64, String, i64) = tx
            .query_row(
                "SELECT name, reference_cash_price, currency_code, is_active FROM product WHERE id = ?1",
                params![item.product_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| format!("product {} not found: {e}", item.product_id))?;
        if is_active == 0 {
            return Err(format!("product {} is not active", item.product_id));
        }
        // Products may be priced in either currency; snapshot the unit
        // price converted into the sale's own currency (via this sale's
        // manual rate) so every item on a sale is directly summable —
        // credit_sale_item has no currency column of its own.
        let unit_price = engine::convert_currency(
            cash_price,
            &product_currency,
            &payload.currency_code,
            payload.manual_exchange_rate_micros,
        );
        cash_total += unit_price * item.quantity;
        item_rows.push((item.product_id, name, unit_price, item.quantity));
    }

    let applied_markup_value = engine::resolve_markup(cash_total, payload.markup_type, payload.markup_input);
    let total_installment_price = cash_total + applied_markup_value;
    if total_installment_price <= 0 {
        return Err("total installment price must be positive".into());
    }

    tx.execute(
        "INSERT INTO credit_sale (
            customer_id, guarantor_id, sale_date, agreed_months, applied_markup_value,
            total_installment_price, currency_code, manual_exchange_rate_micros
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            payload.customer_id,
            payload.guarantor_id,
            payload.sale_date,
            payload.agreed_months,
            applied_markup_value,
            total_installment_price,
            payload.currency_code,
            payload.manual_exchange_rate_micros,
        ],
    )
    .map_err(|e| e.to_string())?;
    let sale_id = tx.last_insert_rowid();

    let mut items = Vec::with_capacity(item_rows.len());
    for (product_id, product_name, snapshot_cash_price, quantity) in item_rows {
        tx.execute(
            "INSERT INTO credit_sale_item (sale_id, product_id, snapshot_cash_price, quantity)
             VALUES (?1, ?2, ?3, ?4)",
            params![sale_id, product_id, snapshot_cash_price, quantity],
        )
        .map_err(|e| e.to_string())?;
        items.push(CreditSaleItemDto {
            id: tx.last_insert_rowid(),
            sale_id,
            product_id,
            product_name,
            snapshot_cash_price,
            quantity,
        });
    }

    let schedule = engine::generate_schedule(total_installment_price, payload.agreed_months, sale_date);
    let mut installments = Vec::with_capacity(schedule.len());
    for scheduled in schedule {
        let due_date = scheduled.due_date.format("%Y-%m-%d").to_string();
        tx.execute(
            "INSERT INTO installment (sale_id, due_date, scheduled_amount) VALUES (?1, ?2, ?3)",
            params![sale_id, due_date, scheduled.amount],
        )
        .map_err(|e| e.to_string())?;
        installments.push(InstallmentDto {
            id: tx.last_insert_rowid(),
            sale_id,
            due_date,
            scheduled_amount: scheduled.amount,
            allocated_amount: 0,
            remaining_amount: scheduled.amount,
            status: "Pending".into(),
        });
    }

    let created_at: String = tx
        .query_row("SELECT created_at FROM credit_sale WHERE id = ?1", params![sale_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let dto = CreditSaleDto {
        id: sale_id,
        customer_id: payload.customer_id,
        guarantor_id: payload.guarantor_id,
        sale_date: payload.sale_date,
        agreed_months: payload.agreed_months,
        applied_markup_value,
        total_installment_price,
        currency_code: payload.currency_code,
        manual_exchange_rate_micros: payload.manual_exchange_rate_micros,
        created_at,
        items,
        installments,
    };

    audit::log_insert(&tx, "credit_sale", sale_id, &dto);
    tx.commit().map_err(|e| e.to_string())?;
    Ok(dto)
}

/// Lists a customer's sales with items and installments inlined, each
/// installment's `allocated_amount`/`remaining_amount` derived live from
/// `PaymentAllocation` (ARCHITECTURE.md §8 — no stored balance column).
pub fn get_sales_for_customer(conn: &Connection, customer_id: i64) -> rusqlite::Result<Vec<CreditSaleDto>> {
    let mut sale_stmt = conn.prepare(
        "SELECT id, customer_id, guarantor_id, sale_date, agreed_months, applied_markup_value,
                total_installment_price, currency_code, manual_exchange_rate_micros, created_at
         FROM credit_sale
         WHERE customer_id = ?1
         ORDER BY sale_date DESC, id DESC",
    )?;

    let sales = sale_stmt
        .query_map(params![customer_id], |row| {
            Ok(CreditSaleDto {
                id: row.get(0)?,
                customer_id: row.get(1)?,
                guarantor_id: row.get(2)?,
                sale_date: row.get(3)?,
                agreed_months: row.get(4)?,
                applied_markup_value: row.get(5)?,
                total_installment_price: row.get(6)?,
                currency_code: row.get(7)?,
                manual_exchange_rate_micros: row.get(8)?,
                created_at: row.get(9)?,
                items: Vec::new(),
                installments: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut item_stmt = conn.prepare(
        "SELECT ci.id, ci.sale_id, ci.product_id, p.name, ci.snapshot_cash_price, ci.quantity
         FROM credit_sale_item ci JOIN product p ON p.id = ci.product_id
         WHERE ci.sale_id = ?1
         ORDER BY ci.id",
    )?;
    let mut installment_stmt = conn.prepare(
        "SELECT i.id, i.sale_id, i.due_date, i.scheduled_amount, i.status,
                COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0) AS allocated
         FROM installment i
         WHERE i.sale_id = ?1
         ORDER BY i.due_date ASC, i.id ASC",
    )?;

    let mut result = Vec::with_capacity(sales.len());
    for mut sale in sales {
        let items = item_stmt
            .query_map(params![sale.id], |row| {
                Ok(CreditSaleItemDto {
                    id: row.get(0)?,
                    sale_id: row.get(1)?,
                    product_id: row.get(2)?,
                    product_name: row.get(3)?,
                    snapshot_cash_price: row.get(4)?,
                    quantity: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let installments = installment_stmt
            .query_map(params![sale.id], |row| {
                let scheduled: i64 = row.get(3)?;
                let allocated: i64 = row.get(5)?;
                Ok(InstallmentDto {
                    id: row.get(0)?,
                    sale_id: row.get(1)?,
                    due_date: row.get(2)?,
                    scheduled_amount: scheduled,
                    allocated_amount: allocated,
                    remaining_amount: scheduled - allocated,
                    status: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        sale.items = items;
        sale.installments = installments;
        result.push(sale);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::{CreateCustomerPayload, CreateProductPayload, CreditSaleItemInput, MarkupType};
    use crate::repo;

    fn setup_customer_and_product(conn: &Connection) -> (i64, i64) {
        let customer = repo::customer::create_customer(
            conn,
            CreateCustomerPayload {
                name: "Test Customer".into(),
                phone: None,
                national_id: "NID-S001".into(),
                address: None,
            },
        )
        .unwrap();
        let product = repo::product::create_product(
            conn,
            CreateProductPayload {
                name: "Fridge".into(),
                reference_cash_price: 300_000,
                currency_code: "IQD".into(),
            },
        )
        .unwrap();
        (customer.id, product.id)
    }

    #[test]
    fn create_sale_generates_schedule_summing_to_total() {
        let mut conn = init_test_db();
        let (customer_id, product_id) = setup_customer_and_product(&conn);

        let sale = create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id,
                guarantor_id: None,
                sale_date: "2026-01-15".into(),
                items: vec![CreditSaleItemInput { product_id, quantity: 2 }],
                markup_type: MarkupType::Percentage,
                markup_input: 1_000, // 10%
                agreed_months: 3,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .expect("create_credit_sale should succeed");

        // cash_total = 600_000, markup 10% = 60_000, total = 660_000
        assert_eq!(sale.applied_markup_value, 60_000);
        assert_eq!(sale.total_installment_price, 660_000);
        assert_eq!(sale.installments.len(), 3);
        assert_eq!(
            sale.installments.iter().map(|i| i.scheduled_amount).sum::<i64>(),
            660_000
        );
        assert!(sale.installments.iter().all(|i| i.status == "Pending"));

        let fetched = get_sales_for_customer(&conn, customer_id).unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].installments.len(), 3);
    }

    #[test]
    fn rejects_empty_items() {
        let mut conn = init_test_db();
        let (customer_id, _) = setup_customer_and_product(&conn);

        let result = create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id,
                guarantor_id: None,
                sale_date: "2026-01-15".into(),
                items: vec![],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 3,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_customer_as_their_own_guarantor() {
        let mut conn = init_test_db();
        let (customer_id, product_id) = setup_customer_and_product(&conn);

        let result = create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id,
                guarantor_id: Some(customer_id),
                sale_date: "2026-01-15".into(),
                items: vec![CreditSaleItemInput { product_id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 3,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn guarantor_id_references_another_customer() {
        let mut conn = init_test_db();
        let (customer_id, product_id) = setup_customer_and_product(&conn);
        let guarantor = repo::customer::create_customer(
            &conn,
            CreateCustomerPayload {
                name: "Guarantor Customer".into(),
                phone: None,
                national_id: "NID-S002".into(),
                address: None,
            },
        )
        .unwrap();

        let sale = create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id,
                guarantor_id: Some(guarantor.id),
                sale_date: "2026-01-15".into(),
                items: vec![CreditSaleItemInput { product_id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .expect("create_credit_sale with a guarantor should succeed");

        assert_eq!(sale.guarantor_id, Some(guarantor.id));
    }

    #[test]
    fn item_prices_are_converted_into_the_sale_currency() {
        let mut conn = init_test_db();
        let customer = repo::customer::create_customer(
            &conn,
            CreateCustomerPayload {
                name: "Cross Currency Buyer".into(),
                phone: None,
                national_id: "NID-S003".into(),
                address: None,
            },
        )
        .unwrap();
        // Priced in USD, but the sale itself will be in IQD.
        let usd_product = repo::product::create_product(
            &conn,
            CreateProductPayload {
                name: "Phone".into(),
                reference_cash_price: 100, // $1.00
                currency_code: "USD".into(),
            },
        )
        .unwrap();

        let sale = create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer.id,
                guarantor_id: None,
                sale_date: "2026-01-15".into(),
                items: vec![CreditSaleItemInput { product_id: usd_product.id, quantity: 2 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_500_000_000, // 1,500 IQD / USD
            },
        )
        .expect("create_credit_sale across currencies should succeed");

        // $1.00 -> 1,500 IQD per unit, times 2 units = 3,000 IQD.
        assert_eq!(sale.items[0].snapshot_cash_price, 1_500);
        assert_eq!(sale.total_installment_price, 3_000);
    }
}
