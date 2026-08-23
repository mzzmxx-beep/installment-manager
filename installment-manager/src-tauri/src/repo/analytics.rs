use chrono::NaiveDate;
use rusqlite::{params, Connection};

use crate::models::{
    CurrencyAmountDto, CustomerOverdueRankingDto, CustomerOverviewDto, CustomerRankingDto, ProductSalesDto,
    SalesSummaryDto,
};

/// Sales and profit totals per currency for sales made within
/// `[from_date, to_date]` (either bound optional — `None` means unbounded).
/// Collected/outstanding reflect the current state of those sales'
/// installments regardless of when any payment landed.
pub fn get_sales_summary(
    conn: &Connection,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> Result<Vec<SalesSummaryDto>, String> {
    struct SaleTotals {
        currency: String,
        count: i64,
        cash: i64,
        markup: i64,
        installment_value: i64,
    }
    let mut sale_stmt = conn
        .prepare(
            "SELECT currency_code, COUNT(*),
                    SUM(total_installment_price - applied_markup_value), SUM(applied_markup_value),
                    SUM(total_installment_price)
             FROM credit_sale
             WHERE (?1 IS NULL OR sale_date >= ?1) AND (?2 IS NULL OR sale_date <= ?2)
             GROUP BY currency_code",
        )
        .map_err(|e| e.to_string())?;
    let sale_totals: Vec<SaleTotals> = sale_stmt
        .query_map(params![from_date, to_date], |row| {
            Ok(SaleTotals {
                currency: row.get(0)?,
                count: row.get(1)?,
                cash: row.get(2)?,
                markup: row.get(3)?,
                installment_value: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(sale_stmt);

    let mut installment_stmt = conn
        .prepare(
            "SELECT cs.currency_code, SUM(i.scheduled_amount),
                    SUM(COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0))
             FROM installment i
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE (?1 IS NULL OR cs.sale_date >= ?1) AND (?2 IS NULL OR cs.sale_date <= ?2)
             GROUP BY cs.currency_code",
        )
        .map_err(|e| e.to_string())?;
    let mut collected_by_currency: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let rows = installment_stmt
        .query_map(params![from_date, to_date], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for (currency, _scheduled, allocated) in rows {
        collected_by_currency.insert(currency, allocated);
    }

    Ok(sale_totals
        .into_iter()
        .map(|t| {
            let collected = collected_by_currency.get(&t.currency).copied().unwrap_or(0);
            SalesSummaryDto {
                currency_code: t.currency,
                sale_count: t.count,
                total_cash_value: t.cash,
                total_markup: t.markup,
                total_installment_value: t.installment_value,
                total_collected: collected,
                total_outstanding: t.installment_value - collected,
            }
        })
        .collect())
}

/// Top `limit` products by total quantity sold, each with revenue (cash
/// value, not counting markup) broken down by currency.
pub fn get_top_products(conn: &Connection, limit: i64) -> Result<Vec<ProductSalesDto>, String> {
    let mut ranking_stmt = conn
        .prepare(
            "SELECT p.id, p.name, SUM(ci.quantity)
             FROM credit_sale_item ci
             JOIN product p ON p.id = ci.product_id
             GROUP BY p.id, p.name
             ORDER BY SUM(ci.quantity) DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let ranking: Vec<(i64, String, i64)> = ranking_stmt
        .query_map(params![limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(ranking_stmt);

    let mut revenue_stmt = conn
        .prepare(
            "SELECT cs.currency_code, SUM(ci.snapshot_cash_price * ci.quantity)
             FROM credit_sale_item ci
             JOIN credit_sale cs ON cs.id = ci.sale_id
             WHERE ci.product_id = ?1
             GROUP BY cs.currency_code",
        )
        .map_err(|e| e.to_string())?;

    let mut result = Vec::with_capacity(ranking.len());
    for (product_id, product_name, total_quantity) in ranking {
        let revenue_by_currency = revenue_stmt
            .query_map(params![product_id], |row| {
                Ok(CurrencyAmountDto { currency_code: row.get(0)?, amount: row.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        result.push(ProductSalesDto { product_id, product_name, total_quantity, revenue_by_currency });
    }
    Ok(result)
}

/// Top `limit` customers by number of completed sales.
pub fn get_top_customers(conn: &Connection, limit: i64) -> Result<Vec<CustomerRankingDto>, String> {
    let mut ranking_stmt = conn
        .prepare(
            "SELECT c.id, c.name, COUNT(cs.id)
             FROM customer c
             JOIN credit_sale cs ON cs.customer_id = c.id
             GROUP BY c.id, c.name
             ORDER BY COUNT(cs.id) DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let ranking: Vec<(i64, String, i64)> = ranking_stmt
        .query_map(params![limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(ranking_stmt);

    let mut total_stmt = conn
        .prepare("SELECT currency_code, SUM(total_installment_price) FROM credit_sale WHERE customer_id = ?1 GROUP BY currency_code")
        .map_err(|e| e.to_string())?;

    let mut result = Vec::with_capacity(ranking.len());
    for (customer_id, customer_name, sale_count) in ranking {
        let total_purchased_by_currency = total_stmt
            .query_map(params![customer_id], |row| {
                Ok(CurrencyAmountDto { currency_code: row.get(0)?, amount: row.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        result.push(CustomerRankingDto { customer_id, customer_name, sale_count, total_purchased_by_currency });
    }
    Ok(result)
}

/// Top `limit` customers by how overdue they are, ranked by the longest
/// any single installment of theirs has been overdue. Remaining amounts
/// are derived from `PaymentAllocation`, matching `get_overdue_installments`.
pub fn get_most_overdue_customers(
    conn: &Connection,
    current_date: &str,
    limit: i64,
) -> Result<Vec<CustomerOverdueRankingDto>, String> {
    let today = NaiveDate::parse_from_str(current_date, "%Y-%m-%d").map_err(|e| format!("invalid current_date: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT customer_id, customer_name, currency_code, due_date, remaining
             FROM (
                 SELECT cs.customer_id, c.name AS customer_name, cs.currency_code, i.due_date,
                        i.scheduled_amount - COALESCE(
                            (SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0
                        ) AS remaining
                 FROM installment i
                 JOIN credit_sale cs ON cs.id = i.sale_id
                 JOIN customer c ON c.id = cs.customer_id
                 WHERE i.due_date < ?1
             )
             WHERE remaining > 0",
        )
        .map_err(|e| e.to_string())?;

    struct Row {
        currency: String,
        days_overdue: i64,
        remaining: i64,
    }
    let rows = stmt
        .query_map(params![current_date], |row| {
            let due_date: String = row.get(3)?;
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, due_date, row.get::<_, i64>(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut by_customer: std::collections::HashMap<i64, (String, Vec<Row>)> = std::collections::HashMap::new();
    for (customer_id, customer_name, currency, due_date, remaining) in rows {
        let due = NaiveDate::parse_from_str(&due_date, "%Y-%m-%d").map_err(|e| format!("invalid due_date in DB: {e}"))?;
        let days_overdue = (today - due).num_days();
        by_customer.entry(customer_id).or_insert_with(|| (customer_name, Vec::new())).1.push(Row {
            currency,
            days_overdue,
            remaining,
        });
    }

    let mut result: Vec<CustomerOverdueRankingDto> = by_customer
        .into_iter()
        .map(|(customer_id, (customer_name, rows))| {
            let max_days_overdue = rows.iter().map(|r| r.days_overdue).max().unwrap_or(0);
            let overdue_installment_count = rows.len() as i64;
            let mut overdue_amount_by_currency: Vec<CurrencyAmountDto> = Vec::new();
            for row in &rows {
                match overdue_amount_by_currency.iter_mut().find(|c| c.currency_code == row.currency) {
                    Some(existing) => existing.amount += row.remaining,
                    None => overdue_amount_by_currency.push(CurrencyAmountDto { currency_code: row.currency.clone(), amount: row.remaining }),
                }
            }
            CustomerOverdueRankingDto { customer_id, customer_name, overdue_installment_count, max_days_overdue, overdue_amount_by_currency }
        })
        .collect();

    result.sort_by(|a, b| b.max_days_overdue.cmp(&a.max_days_overdue));
    result.truncate(limit.max(0) as usize);
    Ok(result)
}

/// Every customer with their activity summary: sale count, total
/// purchased and total remaining per currency, and their most recent
/// sale date. Customers with no sales still appear, with empty totals.
pub fn get_customers_overview(conn: &Connection) -> Result<Vec<CustomerOverviewDto>, String> {
    let mut customer_stmt = conn
        .prepare(
            "SELECT c.id, c.name, COUNT(cs.id), MAX(cs.sale_date)
             FROM customer c
             LEFT JOIN credit_sale cs ON cs.customer_id = c.id
             GROUP BY c.id, c.name
             ORDER BY c.name",
        )
        .map_err(|e| e.to_string())?;
    let customers: Vec<(i64, String, i64, Option<String>)> = customer_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(customer_stmt);

    let mut purchased_stmt = conn
        .prepare("SELECT currency_code, SUM(total_installment_price) FROM credit_sale WHERE customer_id = ?1 GROUP BY currency_code")
        .map_err(|e| e.to_string())?;
    let mut remaining_stmt = conn
        .prepare(
            "SELECT cs.currency_code,
                    SUM(i.scheduled_amount) - SUM(COALESCE(
                        (SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0
                    ))
             FROM installment i
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE cs.customer_id = ?1
             GROUP BY cs.currency_code",
        )
        .map_err(|e| e.to_string())?;

    let mut result = Vec::with_capacity(customers.len());
    for (customer_id, customer_name, sale_count, last_sale_date) in customers {
        let total_purchased_by_currency = purchased_stmt
            .query_map(params![customer_id], |row| {
                Ok(CurrencyAmountDto { currency_code: row.get(0)?, amount: row.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let total_remaining_by_currency = remaining_stmt
            .query_map(params![customer_id], |row| {
                Ok(CurrencyAmountDto { currency_code: row.get(0)?, amount: row.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        result.push(CustomerOverviewDto {
            customer_id,
            customer_name,
            sale_count,
            total_purchased_by_currency,
            total_remaining_by_currency,
            last_sale_date,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_test_db;
    use crate::models::{
        CreateCreditSalePayload, CreateCustomerPayload, CreatePaymentPayload, CreateProductPayload, CreditSaleItemInput,
        MarkupType,
    };
    use crate::repo;

    fn make_customer(conn: &Connection, name: &str, nid: &str) -> i64 {
        repo::customer::create_customer(conn, CreateCustomerPayload { name: name.into(), phone: None, national_id: nid.into(), address: None })
            .unwrap()
            .id
    }

    fn make_product(conn: &Connection, name: &str, price: i64, currency: &str) -> i64 {
        repo::product::create_product(conn, CreateProductPayload { name: name.into(), reference_cash_price: price, currency_code: currency.into() })
            .unwrap()
            .id
    }

    fn make_sale(conn: &mut Connection, customer_id: i64, product_id: i64, quantity: i64, months: i32, sale_date: &str, markup_percent_bps: i64) -> i64 {
        repo::sale::create_credit_sale(
            conn,
            CreateCreditSalePayload {
                customer_id,
                guarantor_id: None,
                sale_date: sale_date.into(),
                items: vec![CreditSaleItemInput { product_id, quantity }],
                markup_type: MarkupType::Percentage,
                markup_input: markup_percent_bps,
                agreed_months: months,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn sales_summary_reports_profit_and_outstanding() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-A1");
        let product = make_product(&conn, "Fridge", 100_000, "IQD");
        // cash 100_000, 10% markup = 10_000, total 110_000, 1 month.
        make_sale(&mut conn, customer, product, 1, 1, "2026-01-01", 1_000);

        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload { customer_id: customer, sale_id: None, payment_date: "2026-02-01".into(), amount_paid: 50_000, currency_code: "IQD".into(), manual_exchange_rate_micros: 1_000_000 },
        )
        .unwrap();

        let summary = get_sales_summary(&conn, None, None).unwrap();
        assert_eq!(summary.len(), 1);
        let s = &summary[0];
        assert_eq!(s.currency_code, "IQD");
        assert_eq!(s.sale_count, 1);
        assert_eq!(s.total_cash_value, 100_000);
        assert_eq!(s.total_markup, 10_000);
        assert_eq!(s.total_installment_value, 110_000);
        assert_eq!(s.total_collected, 50_000);
        assert_eq!(s.total_outstanding, 60_000);
    }

    #[test]
    fn sales_summary_respects_date_range() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-A2");
        let product = make_product(&conn, "TV", 50_000, "IQD");
        make_sale(&mut conn, customer, product, 1, 1, "2026-01-01", 0);
        make_sale(&mut conn, customer, product, 1, 1, "2026-06-01", 0);

        let summary = get_sales_summary(&conn, Some("2026-05-01"), Some("2026-12-31")).unwrap();
        assert_eq!(summary[0].sale_count, 1);
        assert_eq!(summary[0].total_cash_value, 50_000);
    }

    #[test]
    fn top_products_ranks_by_quantity_with_revenue() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-B1");
        let phone = make_product(&conn, "Phone", 10_000, "IQD");
        let laptop = make_product(&conn, "Laptop", 30_000, "IQD");
        make_sale(&mut conn, customer, phone, 5, 1, "2026-01-01", 0);
        make_sale(&mut conn, customer, laptop, 1, 1, "2026-01-02", 0);

        let top = get_top_products(&conn, 10).unwrap();
        assert_eq!(top[0].product_name, "Phone");
        assert_eq!(top[0].total_quantity, 5);
        assert_eq!(top[0].revenue_by_currency[0].amount, 50_000);
        assert_eq!(top[1].product_name, "Laptop");
        assert_eq!(top[1].total_quantity, 1);
    }

    #[test]
    fn top_customers_ranks_by_sale_count() {
        let mut conn = init_test_db();
        let a = make_customer(&conn, "Frequent Buyer", "NID-C1");
        let b = make_customer(&conn, "Occasional Buyer", "NID-C2");
        let product = make_product(&conn, "Chair", 5_000, "IQD");
        make_sale(&mut conn, a, product, 1, 1, "2026-01-01", 0);
        make_sale(&mut conn, a, product, 1, 1, "2026-02-01", 0);
        make_sale(&mut conn, b, product, 1, 1, "2026-01-01", 0);

        let top = get_top_customers(&conn, 10).unwrap();
        assert_eq!(top[0].customer_name, "Frequent Buyer");
        assert_eq!(top[0].sale_count, 2);
        assert_eq!(top[0].total_purchased_by_currency[0].amount, 10_000);
    }

    #[test]
    fn most_overdue_customers_ranks_by_days_overdue() {
        let mut conn = init_test_db();
        let a = make_customer(&conn, "Very Late", "NID-D1");
        let b = make_customer(&conn, "Slightly Late", "NID-D2");
        let product = make_product(&conn, "Sofa", 60_000, "IQD");
        // Due 2026-02-01 (very overdue by 2026-06-01).
        make_sale(&mut conn, a, product, 1, 1, "2026-01-01", 0);
        // Due 2026-05-01 (barely overdue by 2026-06-01... actually 1 month later).
        make_sale(&mut conn, b, product, 1, 1, "2026-04-01", 0);

        let ranking = get_most_overdue_customers(&conn, "2026-06-01", 10).unwrap();
        assert_eq!(ranking.len(), 2);
        assert_eq!(ranking[0].customer_name, "Very Late");
        assert!(ranking[0].max_days_overdue > ranking[1].max_days_overdue);
        assert_eq!(ranking[0].overdue_amount_by_currency[0].amount, 60_000);
    }

    #[test]
    fn customers_overview_includes_customers_with_no_sales() {
        let conn = init_test_db();
        make_customer(&conn, "No Sales Yet", "NID-E1");

        let overview = get_customers_overview(&conn).unwrap();
        assert_eq!(overview.len(), 1);
        assert_eq!(overview[0].sale_count, 0);
        assert!(overview[0].total_purchased_by_currency.is_empty());
        assert_eq!(overview[0].last_sale_date, None);
    }

    #[test]
    fn customers_overview_reports_purchased_and_remaining() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Active Buyer", "NID-E2");
        let product = make_product(&conn, "Oven", 40_000, "IQD");
        make_sale(&mut conn, customer, product, 1, 1, "2026-01-01", 0);

        let overview = get_customers_overview(&conn).unwrap();
        let row = overview.iter().find(|o| o.customer_id == customer).unwrap();
        assert_eq!(row.sale_count, 1);
        assert_eq!(row.total_purchased_by_currency[0].amount, 40_000);
        assert_eq!(row.total_remaining_by_currency[0].amount, 40_000);
        assert_eq!(row.last_sale_date.as_deref(), Some("2026-01-01"));
    }
}
