use rusqlite::{params, Connection};
use serde_json::json;

use crate::audit;
use crate::engine::{self, OutstandingInstallment};
use crate::models::{CreatePaymentPayload, PaymentAllocationDto, PaymentDto};

/// Registers a Payment and allocates it across the customer's outstanding
/// installments oldest-due-date-first (ARCHITECTURE.md §4), inside a single
/// transaction.
///
/// Allocation only considers installments whose sale is in the same
/// currency as the payment: cross-currency conversion during allocation is
/// out of scope for now, though the payment's manual exchange rate is still
/// recorded for the audit trail / future statements. Any amount that can't
/// be allocated (no matching outstanding installments, or overpayment) is
/// reported back as `unallocated_amount` rather than dropped.
pub fn register_payment(conn: &mut Connection, payload: CreatePaymentPayload) -> Result<PaymentDto, String> {
    if payload.amount_paid <= 0 {
        return Err("amount_paid must be positive".into());
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
    }

    let mut outstanding_stmt = tx
        .prepare(
            "SELECT i.id, i.scheduled_amount,
                    COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0)
             FROM installment i
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE cs.customer_id = ?1 AND cs.currency_code = ?2 AND i.status != 'Paid'
             ORDER BY i.due_date ASC, i.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let outstanding: Vec<Outstanding> = outstanding_stmt
        .query_map(params![payload.customer_id, payload.currency_code], |row| {
            Ok(Outstanding {
                id: row.get(0)?,
                scheduled: row.get(1)?,
                already_allocated: row.get(2)?,
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
        })
        .collect();

    let (allocations, unallocated_amount) = engine::allocate_payment(payload.amount_paid, &engine_input);

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
}
