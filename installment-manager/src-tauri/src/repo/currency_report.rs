//! Reports that "explain" currency conversion (ARCHITECTURE.md §5): every
//! place `engine::convert_currency` actually ran, broken down per invoice,
//! per payment, per product, and per customer.
//!
//! `credit_sale_item` has no column for the pre-conversion (original
//! currency) unit price — only the post-conversion `snapshot_cash_price` is
//! stored, in the sale's own currency. This module reconstructs the
//! original amount by inverse-converting that snapshot back through the
//! same sale-level rate and the product's *current* `currency_code`. That's
//! exact as long as a product's currency never changes after creation —
//! true today (there is no edit-product command) but not schema-enforced,
//! so if product editing is ever added, this derivation would need
//! revisiting (or the alternative: snapshotting `original_currency` /
//! `original_unit_price` directly on `credit_sale_item` at sale time).

use rusqlite::{params, Connection};

use crate::engine;
use crate::models::{
    CurrencyAmountDto, CustomerConversionSummaryDto, PaymentConversionDto, ProductConversionSummaryDto,
    SaleConversionDto, SaleConversionItemDto,
};

fn add_amount(list: &mut Vec<CurrencyAmountDto>, currency: &str, amount: i64) {
    match list.iter_mut().find(|c| c.currency_code == currency) {
        Some(existing) => existing.amount += amount,
        None => list.push(CurrencyAmountDto { currency_code: currency.to_string(), amount }),
    }
}

/// Per-invoice detail: only sale items whose product currency differs from
/// the sale's own currency are included — a same-currency item never went
/// through `convert_currency`, so there's nothing to explain about it.
pub fn get_sale_conversions(
    conn: &Connection,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> Result<Vec<SaleConversionDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT cs.id, cs.sale_date, cs.customer_id, c.name, cs.currency_code, cs.manual_exchange_rate_micros,
                    p.id, p.name, p.currency_code, ci.snapshot_cash_price, ci.quantity
             FROM credit_sale_item ci
             JOIN credit_sale cs ON cs.id = ci.sale_id
             JOIN product p ON p.id = ci.product_id
             JOIN customer c ON c.id = cs.customer_id
             WHERE p.currency_code != cs.currency_code
               AND (?1 IS NULL OR cs.sale_date >= ?1) AND (?2 IS NULL OR cs.sale_date <= ?2)
             ORDER BY cs.sale_date DESC, cs.id DESC, ci.id ASC",
        )
        .map_err(|e| e.to_string())?;

    struct Row {
        sale_id: i64,
        sale_date: String,
        customer_id: i64,
        customer_name: String,
        sale_currency: String,
        rate_micros: i64,
        product_id: i64,
        product_name: String,
        product_currency: String,
        snapshot_cash_price: i64,
        quantity: i64,
    }

    let rows = stmt
        .query_map(params![from_date, to_date], |row| {
            Ok(Row {
                sale_id: row.get(0)?,
                sale_date: row.get(1)?,
                customer_id: row.get(2)?,
                customer_name: row.get(3)?,
                sale_currency: row.get(4)?,
                rate_micros: row.get(5)?,
                product_id: row.get(6)?,
                product_name: row.get(7)?,
                product_currency: row.get(8)?,
                snapshot_cash_price: row.get(9)?,
                quantity: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut result: Vec<SaleConversionDto> = Vec::new();
    for row in rows {
        let original_unit_price =
            engine::convert_currency(row.snapshot_cash_price, &row.sale_currency, &row.product_currency, row.rate_micros);
        let item = SaleConversionItemDto {
            product_id: row.product_id,
            product_name: row.product_name,
            original_currency: row.product_currency,
            original_unit_price,
            converted_currency: row.sale_currency.clone(),
            converted_unit_price: row.snapshot_cash_price,
            quantity: row.quantity,
            exchange_rate_micros: row.rate_micros,
        };
        match result.last_mut() {
            Some(sale) if sale.sale_id == row.sale_id => sale.items.push(item),
            _ => result.push(SaleConversionDto {
                sale_id: row.sale_id,
                sale_date: row.sale_date,
                customer_id: row.customer_id,
                customer_name: row.customer_name,
                sale_currency: row.sale_currency,
                items: vec![item],
            }),
        }
    }

    Ok(result)
}

/// Every payment that landed (at least partly) in a currency other than its
/// own. Only two currencies exist in this app (`CHECK (currency_code IN
/// ('IQD','USD'))`), so a payment can only ever have been converted into
/// the one currency that isn't its own — `converted_by_currency` always has
/// exactly one entry, kept as a list only for consistency with the rest of
/// the app's per-currency DTOs.
pub fn get_payment_conversions(
    conn: &Connection,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> Result<Vec<PaymentConversionDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pay.id, pay.payment_date, pay.customer_id, c.name, pay.currency_code, pay.amount_paid,
                    pay.manual_exchange_rate_micros, cs.currency_code, SUM(pa.allocated_amount)
             FROM payment pay
             JOIN customer c ON c.id = pay.customer_id
             JOIN payment_allocation pa ON pa.payment_id = pay.id
             JOIN installment i ON i.id = pa.installment_id
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE cs.currency_code != pay.currency_code
               AND (?1 IS NULL OR pay.payment_date >= ?1) AND (?2 IS NULL OR pay.payment_date <= ?2)
             GROUP BY pay.id, cs.currency_code
             ORDER BY pay.payment_date DESC, pay.id DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![from_date, to_date], |row| {
            Ok(PaymentConversionDto {
                payment_id: row.get(0)?,
                payment_date: row.get(1)?,
                customer_id: row.get(2)?,
                customer_name: row.get(3)?,
                payment_currency: row.get(4)?,
                amount_paid: row.get(5)?,
                exchange_rate_micros: row.get(6)?,
                converted_by_currency: vec![CurrencyAmountDto { currency_code: row.get(7)?, amount: row.get(8)? }],
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Per-product (device) rollup of every sale-item conversion it was part
/// of: how many times it sold in a currency other than its own, and the
/// total value on each side of the conversion.
pub fn get_product_conversion_summary(conn: &Connection) -> Result<Vec<ProductConversionSummaryDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, cs.currency_code, p.currency_code, cs.manual_exchange_rate_micros,
                    ci.snapshot_cash_price, ci.quantity
             FROM credit_sale_item ci
             JOIN credit_sale cs ON cs.id = ci.sale_id
             JOIN product p ON p.id = ci.product_id
             WHERE p.currency_code != cs.currency_code",
        )
        .map_err(|e| e.to_string())?;

    struct Row {
        product_id: i64,
        product_name: String,
        sale_currency: String,
        product_currency: String,
        rate_micros: i64,
        snapshot_cash_price: i64,
        quantity: i64,
    }
    let rows = stmt
        .query_map([], |row| {
            Ok(Row {
                product_id: row.get(0)?,
                product_name: row.get(1)?,
                sale_currency: row.get(2)?,
                product_currency: row.get(3)?,
                rate_micros: row.get(4)?,
                snapshot_cash_price: row.get(5)?,
                quantity: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    struct Acc {
        product_name: String,
        count: i64,
        original: Vec<CurrencyAmountDto>,
        converted: Vec<CurrencyAmountDto>,
    }
    let mut by_product: std::collections::HashMap<i64, Acc> = std::collections::HashMap::new();
    for row in rows {
        let original_unit_price =
            engine::convert_currency(row.snapshot_cash_price, &row.sale_currency, &row.product_currency, row.rate_micros);
        let entry = by_product.entry(row.product_id).or_insert_with(|| Acc {
            product_name: row.product_name.clone(),
            count: 0,
            original: Vec::new(),
            converted: Vec::new(),
        });
        entry.count += 1;
        add_amount(&mut entry.original, &row.product_currency, original_unit_price * row.quantity);
        add_amount(&mut entry.converted, &row.sale_currency, row.snapshot_cash_price * row.quantity);
    }

    let mut result: Vec<ProductConversionSummaryDto> = by_product
        .into_iter()
        .map(|(product_id, acc)| ProductConversionSummaryDto {
            product_id,
            product_name: acc.product_name,
            conversion_count: acc.count,
            original_value_by_currency: acc.original,
            converted_value_by_currency: acc.converted,
        })
        .collect();
    result.sort_by(|a, b| a.product_name.cmp(&b.product_name));
    Ok(result)
}

/// Per-customer rollup combining both conversion sources (their sale items
/// and their payments), so "how much currency conversion touched this
/// customer" has one answer instead of two reports to cross-reference.
pub fn get_customer_conversion_summary(conn: &Connection) -> Result<Vec<CustomerConversionSummaryDto>, String> {
    let mut item_stmt = conn
        .prepare(
            "SELECT cs.customer_id, c.name, cs.currency_code, p.currency_code, cs.manual_exchange_rate_micros,
                    ci.snapshot_cash_price, ci.quantity
             FROM credit_sale_item ci
             JOIN credit_sale cs ON cs.id = ci.sale_id
             JOIN product p ON p.id = ci.product_id
             JOIN customer c ON c.id = cs.customer_id
             WHERE p.currency_code != cs.currency_code",
        )
        .map_err(|e| e.to_string())?;

    struct ItemRow {
        customer_id: i64,
        customer_name: String,
        sale_currency: String,
        product_currency: String,
        rate_micros: i64,
        snapshot_cash_price: i64,
        quantity: i64,
    }
    let item_rows = item_stmt
        .query_map([], |row| {
            Ok(ItemRow {
                customer_id: row.get(0)?,
                customer_name: row.get(1)?,
                sale_currency: row.get(2)?,
                product_currency: row.get(3)?,
                rate_micros: row.get(4)?,
                snapshot_cash_price: row.get(5)?,
                quantity: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(item_stmt);

    let mut payment_stmt = conn
        .prepare(
            "SELECT pay.customer_id, c.name, cs.currency_code, SUM(pa.allocated_amount)
             FROM payment pay
             JOIN customer c ON c.id = pay.customer_id
             JOIN payment_allocation pa ON pa.payment_id = pay.id
             JOIN installment i ON i.id = pa.installment_id
             JOIN credit_sale cs ON cs.id = i.sale_id
             WHERE cs.currency_code != pay.currency_code
             GROUP BY pay.id, cs.currency_code",
        )
        .map_err(|e| e.to_string())?;

    struct PaymentRow {
        customer_id: i64,
        customer_name: String,
        target_currency: String,
        allocated: i64,
    }
    let payment_rows = payment_stmt
        .query_map([], |row| {
            Ok(PaymentRow {
                customer_id: row.get(0)?,
                customer_name: row.get(1)?,
                target_currency: row.get(2)?,
                allocated: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(payment_stmt);

    struct Acc {
        customer_name: String,
        item_count: i64,
        item_original: Vec<CurrencyAmountDto>,
        item_converted: Vec<CurrencyAmountDto>,
        payment_count: i64,
        payment_converted: Vec<CurrencyAmountDto>,
    }
    let mut by_customer: std::collections::HashMap<i64, Acc> = std::collections::HashMap::new();

    for row in item_rows {
        let original_unit_price =
            engine::convert_currency(row.snapshot_cash_price, &row.sale_currency, &row.product_currency, row.rate_micros);
        let entry = by_customer.entry(row.customer_id).or_insert_with(|| Acc {
            customer_name: row.customer_name.clone(),
            item_count: 0,
            item_original: Vec::new(),
            item_converted: Vec::new(),
            payment_count: 0,
            payment_converted: Vec::new(),
        });
        entry.item_count += 1;
        add_amount(&mut entry.item_original, &row.product_currency, original_unit_price * row.quantity);
        add_amount(&mut entry.item_converted, &row.sale_currency, row.snapshot_cash_price * row.quantity);
    }

    for row in payment_rows {
        let entry = by_customer.entry(row.customer_id).or_insert_with(|| Acc {
            customer_name: row.customer_name.clone(),
            item_count: 0,
            item_original: Vec::new(),
            item_converted: Vec::new(),
            payment_count: 0,
            payment_converted: Vec::new(),
        });
        entry.payment_count += 1;
        add_amount(&mut entry.payment_converted, &row.target_currency, row.allocated);
    }

    let mut result: Vec<CustomerConversionSummaryDto> = by_customer
        .into_iter()
        .map(|(customer_id, acc)| CustomerConversionSummaryDto {
            customer_id,
            customer_name: acc.customer_name,
            item_conversion_count: acc.item_count,
            item_original_value_by_currency: acc.item_original,
            item_converted_value_by_currency: acc.item_converted,
            payment_conversion_count: acc.payment_count,
            payment_converted_value_by_currency: acc.payment_converted,
        })
        .collect();
    result.sort_by(|a, b| a.customer_name.cmp(&b.customer_name));
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

    #[test]
    fn sale_conversions_only_include_cross_currency_items() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-CR1");
        // Priced in USD, but the sale itself is in IQD -> should appear.
        let usd_product = make_product(&conn, "Phone", 100, "USD"); // $1.00
        // Priced in IQD, same as the sale -> should NOT appear.
        let iqd_product = make_product(&conn, "Cable", 5_000, "IQD");

        let sale = repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-15".into(),
                items: vec![
                    CreditSaleItemInput { product_id: usd_product, quantity: 2 },
                    CreditSaleItemInput { product_id: iqd_product, quantity: 1 },
                ],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_500_000_000, // 1,500 IQD / USD
            },
        )
        .unwrap();

        let conversions = get_sale_conversions(&conn, None, None).unwrap();
        assert_eq!(conversions.len(), 1);
        let sale_conv = &conversions[0];
        assert_eq!(sale_conv.sale_id, sale.id);
        assert_eq!(sale_conv.items.len(), 1, "the same-currency Cable item must be excluded");
        let item = &sale_conv.items[0];
        assert_eq!(item.product_name, "Phone");
        assert_eq!(item.original_currency, "USD");
        assert_eq!(item.original_unit_price, 100);
        assert_eq!(item.converted_currency, "IQD");
        assert_eq!(item.converted_unit_price, 1_500);
        assert_eq!(item.quantity, 2);
    }

    #[test]
    fn sale_conversions_respect_date_range() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-CR2");
        let usd_product = make_product(&conn, "Tablet", 200, "USD");

        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: usd_product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .unwrap();
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-06-01".into(),
                items: vec![CreditSaleItemInput { product_id: usd_product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .unwrap();

        let conversions = get_sale_conversions(&conn, Some("2026-05-01"), Some("2026-12-31")).unwrap();
        assert_eq!(conversions.len(), 1);
        assert_eq!(conversions[0].sale_date, "2026-06-01");
    }

    #[test]
    fn payment_conversions_report_cross_currency_allocation() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Payer", "NID-CR3");
        let product = make_product(&conn, "Washer", 300_000, "IQD");
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        // Pay in USD against an IQD installment -> conversion happens.
        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id: customer,
                sale_id: None,
                payment_date: "2026-02-01".into(),
                amount_paid: 20_000, // $200.00
                currency_code: "USD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .unwrap();

        let conversions = get_payment_conversions(&conn, None, None).unwrap();
        assert_eq!(conversions.len(), 1);
        let p = &conversions[0];
        assert_eq!(p.payment_currency, "USD");
        assert_eq!(p.amount_paid, 20_000);
        assert_eq!(p.converted_by_currency.len(), 1);
        assert_eq!(p.converted_by_currency[0].currency_code, "IQD");
        assert_eq!(p.converted_by_currency[0].amount, 300_000, "the full installment was covered by the converted payment");
    }

    #[test]
    fn payment_conversions_exclude_same_currency_payments() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Payer", "NID-CR4");
        let product = make_product(&conn, "Oven", 100_000, "IQD");
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id: customer,
                sale_id: None,
                payment_date: "2026-02-01".into(),
                amount_paid: 100_000,
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        let conversions = get_payment_conversions(&conn, None, None).unwrap();
        assert!(conversions.is_empty());
    }

    #[test]
    fn product_conversion_summary_aggregates_across_sales() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Buyer", "NID-CR5");
        let usd_product = make_product(&conn, "Camera", 100, "USD");

        for sale_date in ["2026-01-01", "2026-02-01"] {
            repo::sale::create_credit_sale(
                &mut conn,
                CreateCreditSalePayload {
                    customer_id: customer,
                    guarantor_id: None,
                    sale_date: sale_date.into(),
                    items: vec![CreditSaleItemInput { product_id: usd_product, quantity: 1 }],
                    markup_type: MarkupType::Flat,
                    markup_input: 0,
                    agreed_months: 1,
                    installment_period_unit: "months".into(),
                    currency_code: "IQD".into(),
                    manual_exchange_rate_micros: 1_500_000_000,
                },
            )
            .unwrap();
        }

        let summary = get_product_conversion_summary(&conn).unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].product_name, "Camera");
        assert_eq!(summary[0].conversion_count, 2);
        assert_eq!(summary[0].original_value_by_currency[0].currency_code, "USD");
        assert_eq!(summary[0].original_value_by_currency[0].amount, 200); // $1.00 x 2 sales
        assert_eq!(summary[0].converted_value_by_currency[0].currency_code, "IQD");
        assert_eq!(summary[0].converted_value_by_currency[0].amount, 3_000); // 1,500 x 2
    }

    #[test]
    fn customer_conversion_summary_combines_items_and_payments() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Combo Buyer", "NID-CR6");
        let usd_product = make_product(&conn, "Speaker", 100, "USD");
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: usd_product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .unwrap();
        repo::payment::register_payment(
            &mut conn,
            CreatePaymentPayload {
                customer_id: customer,
                sale_id: None,
                payment_date: "2026-02-01".into(),
                amount_paid: 100, // $1.00, covers the 1,500 IQD installment fully
                currency_code: "USD".into(),
                manual_exchange_rate_micros: 1_500_000_000,
            },
        )
        .unwrap();

        let summary = get_customer_conversion_summary(&conn).unwrap();
        assert_eq!(summary.len(), 1);
        let c = &summary[0];
        assert_eq!(c.customer_name, "Combo Buyer");
        assert_eq!(c.item_conversion_count, 1);
        assert_eq!(c.item_original_value_by_currency[0].amount, 100);
        assert_eq!(c.item_converted_value_by_currency[0].amount, 1_500);
        assert_eq!(c.payment_conversion_count, 1);
        assert_eq!(c.payment_converted_value_by_currency[0].currency_code, "IQD");
        assert_eq!(c.payment_converted_value_by_currency[0].amount, 1_500);
    }

    #[test]
    fn customers_and_products_with_no_conversions_are_absent() {
        let mut conn = init_test_db();
        let customer = make_customer(&conn, "Same Currency Buyer", "NID-CR7");
        let iqd_product = make_product(&conn, "Fan", 20_000, "IQD");
        repo::sale::create_credit_sale(
            &mut conn,
            CreateCreditSalePayload {
                customer_id: customer,
                guarantor_id: None,
                sale_date: "2026-01-01".into(),
                items: vec![CreditSaleItemInput { product_id: iqd_product, quantity: 1 }],
                markup_type: MarkupType::Flat,
                markup_input: 0,
                agreed_months: 1,
                installment_period_unit: "months".into(),
                currency_code: "IQD".into(),
                manual_exchange_rate_micros: 1_000_000,
            },
        )
        .unwrap();

        assert!(get_product_conversion_summary(&conn).unwrap().is_empty());
        assert!(get_customer_conversion_summary(&conn).unwrap().is_empty());
    }
}
