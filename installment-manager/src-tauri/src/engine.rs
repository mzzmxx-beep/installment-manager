//! Pure, float-free financial calculations (ARCHITECTURE.md §5).
//!
//! Nothing in this module touches SQLite — it only does integer math so the
//! rules (round-half-up, remainder-to-last-installment, oldest-first
//! allocation) can be unit tested in isolation from the database.

use chrono::{Datelike, NaiveDate};

use crate::models::MarkupType;

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

/// Splits `total` evenly across `months` monthly installments starting one
/// month after `sale_date`. Any remainder from integer division is folded
/// into the final installment so the schedule always sums to `total`
/// exactly (ARCHITECTURE.md §5).
pub fn generate_schedule(total: i64, months: i32, sale_date: NaiveDate) -> Vec<ScheduledInstallment> {
    assert!(months > 0, "agreed_months must be positive");
    let base = total / months as i64;
    let remainder = total - base * months as i64;

    (1..=months)
        .map(|i| {
            let amount = if i == months { base + remainder } else { base };
            ScheduledInstallment {
                due_date: add_months(sale_date, i),
                amount,
            }
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

pub struct OutstandingInstallment {
    pub id: i64,
    pub remaining: i64,
}

pub struct Allocation {
    pub installment_id: i64,
    pub amount: i64,
}

/// Greedily allocates `payment_amount` across `outstanding` installments,
/// which must already be sorted oldest-due-date-first. Returns the
/// allocations plus any amount left over (payment exceeded total
/// outstanding) instead of silently dropping it.
pub fn allocate_payment(
    payment_amount: i64,
    outstanding: &[OutstandingInstallment],
) -> (Vec<Allocation>, i64) {
    let mut remaining_payment = payment_amount;
    let mut allocations = Vec::new();

    for installment in outstanding {
        if remaining_payment <= 0 {
            break;
        }
        let take = remaining_payment.min(installment.remaining);
        if take > 0 {
            allocations.push(Allocation {
                installment_id: installment.id,
                amount: take,
            });
            remaining_payment -= take;
        }
    }

    (allocations, remaining_payment)
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
        let schedule = generate_schedule(1_000, 3, sale_date);

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
    fn allocation_walks_oldest_first_and_reports_leftover() {
        let outstanding = vec![
            OutstandingInstallment { id: 1, remaining: 100 },
            OutstandingInstallment { id: 2, remaining: 200 },
        ];

        let (allocations, leftover) = allocate_payment(250, &outstanding);
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].installment_id, 1);
        assert_eq!(allocations[0].amount, 100);
        assert_eq!(allocations[1].installment_id, 2);
        assert_eq!(allocations[1].amount, 150);
        assert_eq!(leftover, 0);

        let (allocations, leftover) = allocate_payment(50, &outstanding);
        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].amount, 50);
        assert_eq!(leftover, 0);

        let (allocations, leftover) = allocate_payment(1_000, &outstanding);
        assert_eq!(allocations.iter().map(|a| a.amount).sum::<i64>(), 300);
        assert_eq!(leftover, 700);
    }
}
