use chrono::NaiveDate;
use rusqlite::{params, Connection};

use crate::models::{CurrencyBalanceDto, CustomerDto, CustomerStatementDto, OverdueInstallmentDto};
use crate::repo;

fn get_customer(conn: &Connection, customer_id: i64) -> Result<CustomerDto, String> {
    conn.query_row(
        "SELECT id, name, phone, national_id, address, created_at FROM customer WHERE id = ?1",
        params![customer_id],
        |row| {
            Ok(CustomerDto {
                id: row.get(0)?,
                name: row.get(1)?,
                phone: row.get(2)?,
                national_id: row.get(3)?,
                address: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| format!("customer {customer_id} not found: {e}"))
}

/// Full transaction history and derived balance for one customer
/// (ARCHITECTURE.md §4). Balances are computed fresh from outstanding
/// installments across all of the customer's sales — never read from a
/// cached column.
pub fn get_customer_statement(conn: &Connection, customer_id: i64) -> Result<CustomerStatementDto, String> {
    let customer = get_customer(conn, customer_id)?;
    let sales = repo::sale::get_sales_for_customer(conn, customer_id).map_err(|e| e.to_string())?;
    let payments = repo::payment::get_payments_for_customer(conn, customer_id).map_err(|e| e.to_string())?;

    let mut balances: Vec<CurrencyBalanceDto> = Vec::new();
    for sale in &sales {
        let remaining: i64 = sale.installments.iter().map(|i| i.remaining_amount).sum();
        if remaining == 0 {
            continue;
        }
        match balances.iter_mut().find(|b| b.currency_code == sale.currency_code) {
            Some(existing) => existing.total_remaining += remaining,
            None => balances.push(CurrencyBalanceDto {
                currency_code: sale.currency_code.clone(),
                total_remaining: remaining,
            }),
        }
    }

    Ok(CustomerStatementDto { customer, sales, payments, balances })
}

/// Every installment overdue as of `current_date` across all customers
/// (ARCHITECTURE.md §4): `due_date < current_date` and still short of
/// `scheduled_amount`, ordered most-overdue-first. Remaining amounts are
/// always derived from `PaymentAllocation`, matching the rest of the app
/// (ARCHITECTURE.md §8) — an installment's cached `status` column is not
/// consulted here, only the actual numbers.
pub fn get_overdue_installments(conn: &Connection, current_date: &str) -> Result<Vec<OverdueInstallmentDto>, String> {
    let today = NaiveDate::parse_from_str(current_date, "%Y-%m-%d").map_err(|e| format!("invalid current_date: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, sale_id, customer_id, customer_name, due_date, currency_code, scheduled_amount, remaining
             FROM (
                 SELECT i.id, i.sale_id, cs.customer_id, c.name AS customer_name, i.due_date,
                        cs.currency_code, i.scheduled_amount,
                        i.scheduled_amount - COALESCE(
                            (SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0
                        ) AS remaining
                 FROM installment i
                 JOIN credit_sale cs ON cs.id = i.sale_id
                 JOIN customer c ON c.id = cs.customer_id
                 WHERE i.due_date < ?1
             )
             WHERE remaining > 0
             ORDER BY due_date ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![current_date], |row| {
            let due_date: String = row.get(4)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                due_date,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut result = Vec::with_capacity(rows.len());
    for (installment_id, sale_id, customer_id, customer_name, due_date, currency_code, scheduled_amount, remaining_amount) in rows {
        let due = NaiveDate::parse_from_str(&due_date, "%Y-%m-%d").map_err(|e| format!("invalid due_date in DB: {e}"))?;
        let days_overdue = (today - due).num_days();
        result.push(OverdueInstallmentDto {
            installment_id,
            sale_id,
            customer_id,
            customer_name,
            due_date,
            days_overdue,
            currency_code,
            scheduled_amount,
            remaining_amount,
        });
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::{CreateCreditSalePayload, CreateCustomerPayload, CreateProductPayload, CreatePaymentPayload, CreditSaleItemInput, MarkupType};

    fn setup_sale(conn: &mut Connection, sale_date: &str, months: i32) -> (i64, i64) {
        let customer = repo::customer::create_customer(
            conn,
            CreateCustomerPayload { name: "Report Customer".into(), phone: None, national_id: "NID-R001".into(), address: None },
        )
        .unwrap();
        let product = repo::product::create_product(
            conn,
            CreateProductPayload { name: "Washer".into(), reference_cash_price: 300_000, currency_code: "IQD".into() },
        )
        .unwrap();
        let sale = repo::sale::create_credit_sale(
            conn,
            CreateCreditSalePayload {
                customer_id: customer.id,
                guarantor_id: None,
                sale_date: sale_date.into(),
                items: vec![CreditSaleItemInput { product_id: product.id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: months,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();
        (customer.id, sale.id)
    }

    #[test]
    fn statement_includes_sales_payments_and_derived_balance() {
        let mut conn = init_test_db();
        let (customer_id, _) = setup_sale(&mut conn, "2026-01-01", 3);
        // 300_000 / 3 = 100_000/month; pay 100_000 to clear the first installment.
        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id,
                sale_id: None,
                payment_date: "2026-02-01".into(),
                amount_paid: 100_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        let statement = get_customer_statement(&conn, customer_id).unwrap();
        assert_eq!(statement.customer.id, customer_id);
        assert_eq!(statement.sales.len(), 1);
        assert_eq!(statement.payments.len(), 1);
        assert_eq!(statement.balances.len(), 1);
        assert_eq!(statement.balances[0].currency_code, "IQD");
        assert_eq!(statement.balances[0].total_remaining, 200_000);
    }

    #[test]
    fn statement_rejects_an_unknown_customer() {
        let conn = init_test_db();
        assert!(get_customer_statement(&conn, 999).is_err());
    }

    #[test]
    fn overdue_installments_are_found_and_sorted_by_due_date() {
        let mut conn = init_test_db();
        // Due 2026-02-01, 2026-03-01, 2026-04-01.
        setup_sale(&mut conn, "2026-01-01", 3);

        let overdue = get_overdue_installments(&conn, "2026-03-15").unwrap();
        assert_eq!(overdue.len(), 2, "the Feb and Mar installments are overdue as of Mar 15");
        assert_eq!(overdue[0].due_date, "2026-02-01");
        assert_eq!(overdue[0].days_overdue, 42);
        assert_eq!(overdue[1].due_date, "2026-03-01");
        assert_eq!(overdue[1].days_overdue, 14);
    }

    #[test]
    fn a_fully_paid_installment_is_not_overdue() {
        let mut conn = init_test_db();
        let (customer_id, _) = setup_sale(&mut conn, "2026-01-01", 1);
        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id,
                sale_id: None,
                payment_date: "2026-02-01".into(),
                amount_paid: 300_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        let overdue = get_overdue_installments(&conn, "2026-06-01").unwrap();
        assert!(overdue.is_empty());
    }
}
