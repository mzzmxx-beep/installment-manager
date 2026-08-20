use rusqlite::{params, Connection};
use serde_json::json;

use crate::audit;
use crate::engine::{self, OutstandingInstallment};
use crate::models::{CreatePaymentPayload, PaymentAllocationDto, PaymentDto};

/// Registers a Payment and allocates it across *all* of the customer's
/// outstanding installments oldest-due-date-first (ARCHITECTURE.md §4),
/// regardless of which currency each underlying sale was made in, inside a
/// single transaction.
///
/// The payment can be made in either currency; installments in the other
/// currency are converted using this payment's own manual exchange rate
/// (ARCHITECTURE.md §5 — one manual rate per transaction, never a global
/// config). Each `PaymentAllocation.allocated_amount` is still stored in
/// the installment's own currency, never the payment's, so it stays
/// directly summable against `scheduled_amount`. Any amount that can't be
/// allocated (overpayment, or nothing outstanding) is reported back as
/// `unallocated_amount` rather than dropped.
pub fn register_payment(conn: &mut Connection, payload: CreatePaymentPayload) -> Result<PaymentDto, String> {
    if payload.amount_paid <= 0 {
        return Err("amount_paid must be positive".into());
    }
    if payload.manual_exchange_rate_micros <= 0 {
        return Err("manual_exchange_rate_micros must be positive".into());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO payment (customer_id, payment_date, amount_paid, currency_code, manual_exchange_rate_micros)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            payload.customer_id,
            payload.payment_date,
            payload.amount_paid,
            payload.currency_code,
            payload.manual_exchange_rate_micros,
        ],
    )
    .map_err(|e| e.to_string())?;
    let payment_id = tx.last_insert_rowid();

    struct Outstanding {
        id: i64,
        scheduled: i64,
        already_allocated: i64,
        currency: String,
    }

    let mut outstanding_stmt = tx
        .prepare(
            "SELECT i.id, i.scheduled_amount,
                    COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0),
                    cs.currency_code
             FROM installment i
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE cs.customer_id = ?1 AND i.status != 'Paid'
             ORDER BY i.due_date ASC, i.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let outstanding: Vec<Outstanding> = outstanding_stmt
        .query_map(params![payload.customer_id], |row| {
            Ok(Outstanding {
                id: row.get(0)?,
                scheduled: row.get(1)?,
                already_allocated: row.get(2)?,
                currency: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(outstanding_stmt);

    let engine_input: Vec<OutstandingInstallment> = outstanding
        .iter()
        .map(|o| OutstandingInstallment {
            id: o.id,
            remaining: o.scheduled - o.already_allocated,
            currency: o.currency.clone(),
        })
        .collect();

    let (allocations, unallocated_amount) = engine::allocate_payment(
        payload.amount_paid,
        &payload.currency_code,
        payload.manual_exchange_rate_micros,
        &engine_input,
    );

    let mut allocation_dtos = Vec::with_capacity(allocations.len());
    for allocation in &allocations {
        tx.execute(
            "INSERT INTO payment_allocation (payment_id, installment_id, allocated_amount) VALUES (?1, ?2, ?3)",
            params![payment_id, allocation.installment_id, allocation.amount],
        )
        .map_err(|e| e.to_string())?;
        allocation_dtos.push(PaymentAllocationDto {
            id: tx.last_insert_rowid(),
            payment_id,
            installment_id: allocation.installment_id,
            allocated_amount: allocation.amount,
        });

        let outstanding_row = outstanding
            .iter()
            .find(|o| o.id == allocation.installment_id)
            .expect("allocation must reference a fetched outstanding installment");
        let new_allocated_total = outstanding_row.already_allocated + allocation.amount;
        let old_status = if outstanding_row.already_allocated == 0 { "Pending" } else { "Partial" };
        let new_status = if new_allocated_total >= outstanding_row.scheduled { "Paid" } else { "Partial" };

        if new_status != old_status {
            tx.execute(
                "UPDATE installment SET status = ?1 WHERE id = ?2",
                params![new_status, allocation.installment_id],
            )
            .map_err(|e| e.to_string())?;
            audit::log_update(
                &tx,
                "installment",
                allocation.installment_id,
                &json!({ "status": old_status }),
                &json!({ "status": new_status }),
            );
        }
    }

    let created_at: String = tx
        .query_row("SELECT created_at FROM payment WHERE id = ?1", params![payment_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let dto = PaymentDto {
        id: payment_id,
        customer_id: payload.customer_id,
        payment_date: payload.payment_date,
        amount_paid: payload.amount_paid,
        currency_code: payload.currency_code,
        manual_exchange_rate_micros: payload.manual_exchange_rate_micros,
        created_at,
        allocations: allocation_dtos,
        unallocated_amount,
    };

    audit::log_insert(&tx, "payment", payment_id, &dto);
    tx.commit().map_err(|e| e.to_string())?;
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::{CreateCreditSalePayload, CreateCustomerPayload, CreateProductPayload, CreditSaleItemInput, MarkupType};
    use crate::repo;

    fn setup_sale(conn: &mut Connection) -> i64 {
        let customer = repo::customer::create_customer(
            conn,
            CreateCustomerPayload {
                name: "Payer".into(),
                phone: None,
                national_id: "NID-P001".into(),
                address: None,
            },
        )
        .unwrap();
        let product = repo::product::create_product(
            conn,
            CreateProductPayload {
                name: "Laptop".into(),
                reference_cash_price: 300_000,
                currency_code: "IQD".into(),
            },
        )
        .unwrap();
        repo::sale::create_credit_sale(
            conn,
            CreateCreditSalePayload {
                customer_id: customer.id,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: product.id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 3,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();
        customer.id
    }

    #[test]
    fn payment_allocates_oldest_first_and_updates_status() {
        let mut conn = init_test_db();
        let customer_id = setup_sale(&mut conn);
        // 300_000 / 3 months = 100_000 each.

        let payment = register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id,
                payment_date: "2026-02-01".into(),
                amount_paid: 150_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .expect("register_payment should succeed");

        assert_eq!(payment.allocations.len(), 2);
        assert_eq!(payment.allocations[0].allocated_amount, 100_000);
        assert_eq!(payment.allocations[1].allocated_amount, 50_000);
        assert_eq!(payment.unallocated_amount, 0);

        let sales = repo::sale::get_sales_for_customer(&conn, customer_id).unwrap();
        let installments = &sales[0].installments;
        assert_eq!(installments[0].status, "Paid");
        assert_eq!(installments[1].status, "Partial");
        assert_eq!(installments[1].remaining_amount, 50_000);
        assert_eq!(installments[2].status, "Pending");
    }

    #[test]
    fn overpayment_is_reported_as_unallocated() {
        let mut conn = init_test_db();
        let customer_id = setup_sale(&mut conn);

        let payment = register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id,
                payment_date: "2026-02-01".into(),
                amount_paid: 1_000_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        assert_eq!(payment.unallocated_amount, 700_000);
        let sales = repo::sale::get_sales_for_customer(&conn, customer_id).unwrap();
        assert!(sales[0].installments.iter().all(|i| i.status == "Paid"));
    }

    #[test]
    fn rejects_non_positive_exchange_rate() {
        let mut conn = init_test_db();
        let customer_id = setup_sale(&mut conn);

        let result = register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id,
                payment_date: "2026-02-01".into(),
                amount_paid: 1_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 0,
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn payment_currency_can_differ_from_the_sale_currency() {
        let mut conn = init_test_db();

        let customer = repo::customer::create_customer(
            &mut conn,
            CreateCustomerPayload {
                name: "Cross Currency Payer".into(),
                phone: None,
                national_id: "NID-P002".into(),
                address: None,
            },
        )
        .unwrap();

        let iqd_product = repo::product::create_product(
            &mut conn,
            CreateProductPayload {
                name: "Fridge".into(),
                reference_cash_price: 10_000,
                currency_code: "IQD".into(),
            },
        )
        .unwrap();
        // Due 2026-02-01: a single 10,000 IQD installment.
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer.id,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: iqd_product.id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        let usd_product = repo::product::create_product(
            &mut conn,
            CreateProductPayload {
                name: "Phone".into(),
                reference_cash_price: 200, // $2.00
                currency_code: "USD".into(),
            },
        )
        .unwrap();
        // Sold later, so its installment is due after the IQD one (2026-03-01).
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer.id,
                guarantor_id: None,
                sale_date: "2026-02-01".into(),
                items: vec![CreditSaleItemInput { product_id: usd_product.id, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                currency_code: "USD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        // Pay $10.00 at 1,500 IQD/USD: covers the 10,000 IQD installment
        // (worth $6.67) in full, then the $2.00 USD installment in full,
        // leaving $1.33 unallocated.
        let payment = register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id: customer.id,
                payment_date: "2026-03-01".into(),
                amount_paid: 1_000, // $10.00
                currency_code: "USD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .expect("cross-currency register_payment should succeed");

        assert_eq!(payment.allocations.len(), 2);
        assert_eq!(payment.allocations[0].allocated_amount, 10_000); // IQD installment, in IQD
        assert_eq!(payment.allocations[1].allocated_amount, 200); // USD installment, in USD cents
        assert_eq!(payment.unallocated_amount, 133); // $1.33

        let sales = repo::sale::get_sales_for_customer(&conn, customer.id).unwrap();
        for sale in &sales {
            assert!(sale.installments.iter().all(|i| i.status == "Paid"), "{:?}", sale.installments);
        }
    }
}
