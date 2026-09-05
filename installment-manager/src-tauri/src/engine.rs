//! Pure, float-free financial calculations (ARCHITECTURE.md §5).
//!
//! Nothing in this module touches SQLite — it only does integer math so the
//! rules (round-half-up, remainder-to-last-installment, oldest-first
//! allocation) can be unit tested in isolation from the database.

use chrono::{Datelike, Duration, NaiveDate};

use crate::models::MarkupType;

/// How installment due dates are spaced apart (see
/// `models::CreateCreditSalePayload::installment_period_unit`, which carries
/// this as a plain string across the IPC boundary — this enum is the
/// engine's internal, validated representation of that string).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodUnit {
    Months,
    Days,
}

/// Rounds `numerator / denominator` half-up. The single rounding point for
/// all money math (ARCHITECTURE.md §5) — never round mid-calculation.
fn round_half_up(numerator: i128, denominator: i128) -> i64 {
    debug_assert!(denominator > 0);
    ((numerator + denominator / 2) / denominator) as i64
}

/// Resolves a manually-entered markup (flat amount or percentage) into the
/// exact integer amount to snapshot on the sale. Percentage markups are
/// basis points (1/100 of a percent), e.g. `1000` = 10.00%, so the whole
/// computation stays integer-only.
pub fn resolve_markup(cash_total: i64, markup_type: MarkupType, markup_input: i64) -> i64 {
    match markup_type {
        MarkupType::Flat => markup_input,
        MarkupType::Percentage => round_half_up(cash_total as i128 * markup_input as i128, 10_000),
    }
}

pub struct ScheduledInstallment {
    pub due_date: NaiveDate,
    pub amount: i64,
}

/// Splits `total` evenly across `count` installments, due one `unit` apart
/// starting one `unit` after `sale_date` (e.g. `Months` -> the 1st, 2nd, 3rd
/// calendar month after the sale; `Days` -> the 1st, 2nd, 3rd day after).
/// Any remainder from integer division is folded into the final installment
/// so the schedule always sums to `total` exactly (ARCHITECTURE.md §5).
pub fn generate_schedule(total: i64, count: i32, sale_date: NaiveDate, unit: PeriodUnit) -> Vec<ScheduledInstallment> {
    assert!(count > 0, "agreed_months must be positive");
    let base = total / count as i64;
    let remainder = total - base * count as i64;

    (1..=count)
        .map(|i| {
            let amount = if i == count { base + remainder } else { base };
            let due_date = match unit {
                PeriodUnit::Months => add_months(sale_date, i),
                PeriodUnit::Days => sale_date + Duration::days(i as i64),
            };
            ScheduledInstallment { due_date, amount }
        })
        .collect()
}

/// Adds `months` calendar months to `date`, clamping the day to the last
/// valid day of the target month (e.g. Jan 31 + 1 month -> Feb 28/29).
fn add_months(date: NaiveDate, months: i32) -> NaiveDate {
    let total_month_index = date.year() * 12 + (date.month() as i32 - 1) + months;
    let year = total_month_index.div_euclid(12);
    let month = (total_month_index.rem_euclid(12) + 1) as u32;
    let day = date.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).expect("valid date")
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .expect("valid date")
        .pred_opt()
        .expect("valid date")
        .day()
}

/// Converts `amount` from `from_currency` into `to_currency` using
/// `rate_micros` — IQD per 1 USD, scaled by 1,000,000 (ARCHITECTURE.md §5,
/// same convention as `credit_sale`/`payment.manual_exchange_rate_micros`).
/// Same-currency conversions are a no-op (avoids introducing rounding noise
/// on the common case). Panics if `rate_micros <= 0` for a cross-currency
/// conversion — callers must validate the rate before reaching this point.
pub fn convert_currency(amount: i64, from_currency: &str, to_currency: &str, rate_micros: i64) -> i64 {
    if from_currency == to_currency {
        return amount;
    }
    match (from_currency, to_currency) {
        ("USD", "IQD") => round_half_up(amount as i128 * rate_micros as i128, 100_000_000),
        ("IQD", "USD") => round_half_up(amount as i128 * 100_000_000, rate_micros as i128),
        _ => amount,
    }
}

pub struct OutstandingInstallment {
    pub id: i64,
    pub remaining: i64,
    pub currency: String,
}

pub struct Allocation {
    pub installment_id: i64,
    pub amount: i64,
}

/// Greedily allocates a payment of `payment_amount` (in `payment_currency`)
/// across `outstanding` installments, which must already be sorted
/// oldest-due-date-first, regardless of each installment's own currency
/// (ARCHITECTURE.md §4 generalized across currencies). Installments in a
/// different currency than the payment are converted via `rate_micros`, the
/// single rate entered for this payment. Each `Allocation.amount` is always
/// denominated in that installment's own currency — never the payment's —
/// since it is later summed directly against `scheduled_amount` (ARCHITECTURE.md
/// §8: installment balances are derived, never stored). Returns the
/// allocations plus any payment amount left over (payment exceeded total
/// outstanding, or nothing was outstanding) instead of silently dropping it.
pub fn allocate_payment(
    payment_amount: i64,
    payment_currency: &str,
    rate_micros: i64,
    outstanding: &[OutstandingInstallment],
) -> (Vec<Allocation>, i64) {
    let mut remaining_payment = payment_amount;
    let mut allocations = Vec::new();

    for installment in outstanding {
        if remaining_payment <= 0 {
            break;
        }
        let available = convert_currency(remaining_payment, payment_currency, &installment.currency, rate_micros);
        let take = available.min(installment.remaining);
        if take <= 0 {
            continue;
        }
        allocations.push(Allocation {
            installment_id: installment.id,
            amount: take,
        });
        // Re-derive the payment-currency remainder from what's actually left
        // in the installment's currency, rather than converting `take` back
        // directly — when this installment absorbs the payment in full,
        // `available - take` is exactly 0 and skips a redundant round-trip
        // rounding step.
        let leftover_in_installment_currency = available - take;
        remaining_payment = convert_currency(leftover_in_installment_currency, &installment.currency, payment_currency, rate_micros);
    }

    (allocations, remaining_payment.max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_markup_is_used_as_is() {
        assert_eq!(resolve_markup(100_000, MarkupType::Flat, 15_000), 15_000);
    }

    #[test]
    fn percentage_markup_rounds_half_up() {
        // 10.5% of 100_050 = 10_505.25 -> rounds to 10_505.
        assert_eq!(resolve_markup(100_050, MarkupType::Percentage, 1_050), 10_505);
    }

    #[test]
    fn schedule_sums_exactly_to_total_with_remainder_on_last() {
        let sale_date = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        let schedule = generate_schedule(1_000, 3, sale_date, PeriodUnit::Months);

        assert_eq!(schedule.len(), 3);
        assert_eq!(schedule[0].amount, 333);
        assert_eq!(schedule[1].amount, 333);
        assert_eq!(schedule[2].amount, 334);
        assert_eq!(schedule.iter().map(|s| s.amount).sum::<i64>(), 1_000);

        // Jan 31 + 1 month clamps to Feb 28 (2026 is not a leap year).
        assert_eq!(schedule[0].due_date, NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert_eq!(schedule[1].due_date, NaiveDate::from_ymd_opt(2026, 3, 31).unwrap());
        assert_eq!(schedule[2].due_date, NaiveDate::from_ymd_opt(2026, 4, 30).unwrap());
    }

    #[test]
    fn schedule_with_days_unit_spaces_installments_one_day_apart() {
        let sale_date = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        let schedule = generate_schedule(1_000, 3, sale_date, PeriodUnit::Days);

        assert_eq!(schedule.len(), 3);
        assert_eq!(schedule.iter().map(|s| s.amount).sum::<i64>(), 1_000);
        assert_eq!(schedule[0].due_date, NaiveDate::from_ymd_opt(2026, 2, 1).unwrap());
        assert_eq!(schedule[1].due_date, NaiveDate::from_ymd_opt(2026, 2, 2).unwrap());
        assert_eq!(schedule[2].due_date, NaiveDate::from_ymd_opt(2026, 2, 3).unwrap());
    }

    #[test]
    fn allocation_walks_oldest_first_and_reports_leftover() {
        let outstanding = vec![
            OutstandingInstallment { id: 1, remaining: 100, currency: "IQD".into() },
            OutstandingInstallment { id: 2, remaining: 200, currency: "IQD".into() },
        ];

        let (allocations, leftover) = allocate_payment(250, "IQD", 1_000_000, &outstanding);
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].installment_id, 1);
        assert_eq!(allocations[0].amount, 100);
        assert_eq!(allocations[1].installment_id, 2);
        assert_eq!(allocations[1].amount, 150);
        assert_eq!(leftover, 0);

        let (allocations, leftover) = allocate_payment(50, "IQD", 1_000_000, &outstanding);
        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].amount, 50);
        assert_eq!(leftover, 0);

        let (allocations, leftover) = allocate_payment(1_000, "IQD", 1_000_000, &outstanding);
        assert_eq!(allocations.iter().map(|a| a.amount).sum::<i64>(), 300);
        assert_eq!(leftover, 700);
    }

    #[test]
    fn convert_currency_is_a_no_op_for_matching_currencies() {
        assert_eq!(convert_currency(12_345, "IQD", "IQD", 1), 12_345);
        assert_eq!(convert_currency(12_345, "USD", "USD", 1), 12_345);
    }

    #[test]
    fn convert_currency_round_trips_at_a_clean_rate() {
        // 1,500 IQD per 1 USD.
        let rate = 1_500_000_000;
        assert_eq!(convert_currency(100, "USD", "IQD", rate), 1_500); // $1.00 -> 1,500 IQD
        assert_eq!(convert_currency(1_500, "IQD", "USD", rate), 100); // 1,500 IQD -> $1.00
    }

    #[test]
    fn allocation_converts_across_a_currency_boundary() {
        // 1,500 IQD per 1 USD.
        let rate = 1_500_000_000;
        let outstanding = vec![
            OutstandingInstallment { id: 1, remaining: 10_000, currency: "IQD".into() }, // due first
            OutstandingInstallment { id: 2, remaining: 200, currency: "USD".into() },    // $2.00, due second
        ];

        // Pay $10.00 in USD: covers the 10,000 IQD installment in full
        // (worth $6.67 at this rate), then the $2.00 USD installment in
        // full, leaving $1.33 unallocated.
        let (allocations, leftover) = allocate_payment(1_000, "USD", rate, &outstanding);

        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].installment_id, 1);
        assert_eq!(allocations[0].amount, 10_000); // stored in the installment's own currency (IQD)
        assert_eq!(allocations[1].installment_id, 2);
        assert_eq!(allocations[1].amount, 200); // stored in USD cents
        assert_eq!(leftover, 133); // $1.33 left over, in the payment's currency (USD)
    }

    #[test]
    fn allocation_fully_absorbed_by_one_installment_has_no_rounding_leftover() {
        // 1,310 IQD per 1 USD - a rate that doesn't divide evenly.
        let rate = 1_310_000_000;
        let outstanding = vec![OutstandingInstallment {
            id: 1,
            remaining: 1_000_000, // far more than the payment can cover
            currency: "IQD".into(),
        }];

        let (allocations, leftover) = allocate_payment(500, "USD", rate, &outstanding);

        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].amount, convert_currency(500, "USD", "IQD", rate));
        assert_eq!(leftover, 0);
    }
}
