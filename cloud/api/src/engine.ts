// Pure, float-free financial calculations. Ported line-for-line from the
// original Rust (installment-manager/src-tauri/src/engine.rs) -- same
// rules (round-half-up, remainder-to-last-installment, oldest-first
// allocation), same money conventions: no float/double anywhere, USD in
// cents, IQD in exact Dinars, exchange rates scaled by 1_000_000.
//
// JS has no i64/i128 -- amounts here comfortably fit in Number's exact
// integer range (2^53) for any realistic shop's data, and BigInt is used
// for the one multiplication (amount * rate) that could otherwise exceed
// it before rounding.

export type PeriodUnit = "months" | "days";
export type MarkupType = "flat" | "percentage";

/** Rounds numerator/denominator half-up. The single rounding point for all money math. */
function roundHalfUp(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const result = (numerator + denominator / 2n) / denominator;
  return Number(result);
}

/**
 * Resolves a manually-entered markup into the exact integer amount to
 * snapshot on the sale. Percentage markups are basis points (1/100 of a
 * percent), e.g. 1000 = 10.00%.
 */
export function resolveMarkup(cashTotal: number, markupType: MarkupType, markupInput: number): number {
  if (markupType === "flat") return markupInput;
  return roundHalfUp(BigInt(cashTotal) * BigInt(markupInput), 10_000n);
}

export interface ScheduledInstallment {
  dueDate: string; // YYYY-MM-DD
  amount: number;
}

/** Adds `months` calendar months to a date, clamping the day to the last valid day of the target month. */
function addMonths(date: Date, months: number): Date {
  const totalMonthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(totalMonthIndex / 12);
  const month = ((totalMonthIndex % 12) + 12) % 12; // 0-indexed
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month));
  return new Date(Date.UTC(year, month, day));
}

function daysInMonth(year: number, month0: number): number {
  // Day 0 of the next month == last day of this month.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function toDateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Splits `total` evenly across `count` installments, due one `unit` apart
 * starting one `unit` after `saleDate`. Any remainder from integer
 * division is folded into the final installment so the schedule always
 * sums to `total` exactly.
 */
export function generateSchedule(
  total: number,
  count: number,
  saleDate: string,
  unit: PeriodUnit,
): ScheduledInstallment[] {
  if (count <= 0) throw new Error("agreed_months must be positive");
  const base = Math.trunc(total / count);
  const remainder = total - base * count;
  const start = toDateOnly(saleDate);

  const schedule: ScheduledInstallment[] = [];
  for (let i = 1; i <= count; i++) {
    const amount = i === count ? base + remainder : base;
    const due = unit === "months" ? addMonths(start, i) : new Date(start.getTime() + i * 86_400_000);
    schedule.push({ dueDate: fromDateOnly(due), amount });
  }
  return schedule;
}

/**
 * Converts `amount` from `fromCurrency` into `toCurrency` using
 * `rateMicros` (IQD per 1 USD, scaled by 1,000,000). Same-currency
 * conversions are a no-op. Throws if `rateMicros <= 0` for a
 * cross-currency conversion -- callers must validate the rate first.
 */
export function convertCurrency(amount: number, fromCurrency: string, toCurrency: string, rateMicros: number): number {
  if (fromCurrency === toCurrency) return amount;
  if (rateMicros <= 0) throw new Error("rate_micros must be positive for a cross-currency conversion");
  if (fromCurrency === "USD" && toCurrency === "IQD") {
    return roundHalfUp(BigInt(amount) * BigInt(rateMicros), 100_000_000n);
  }
  if (fromCurrency === "IQD" && toCurrency === "USD") {
    return roundHalfUp(BigInt(amount) * 100_000_000n, BigInt(rateMicros));
  }
  return amount;
}

export interface OutstandingInstallment {
  id: string;
  remaining: number;
  currency: string;
}

export interface Allocation {
  installmentId: string;
  amount: number;
}

/**
 * Greedily allocates a payment across `outstanding` installments, which
 * must already be sorted oldest-due-date-first, regardless of each
 * installment's own currency. Installments in a different currency than
 * the payment are converted via `rateMicros`. Each allocation amount is
 * always denominated in that installment's own currency, never the
 * payment's. Returns the allocations plus any payment amount left over.
 */
export function allocatePayment(
  paymentAmount: number,
  paymentCurrency: string,
  rateMicros: number,
  outstanding: OutstandingInstallment[],
): { allocations: Allocation[]; unallocatedAmount: number } {
  let remainingPayment = paymentAmount;
  const allocations: Allocation[] = [];

  for (const installment of outstanding) {
    if (remainingPayment <= 0) break;
    const available = convertCurrency(remainingPayment, paymentCurrency, installment.currency, rateMicros);
    const take = Math.min(available, installment.remaining);
    if (take <= 0) continue;

    allocations.push({ installmentId: installment.id, amount: take });

    // Re-derive the payment-currency remainder from what's actually left
    // in the installment's currency, rather than converting `take` back
    // directly -- when this installment absorbs the payment in full,
    // `available - take` is exactly 0 and skips a redundant round-trip.
    const leftoverInInstallmentCurrency = available - take;
    remainingPayment = convertCurrency(leftoverInInstallmentCurrency, installment.currency, paymentCurrency, rateMicros);
  }

  return { allocations, unallocatedAmount: Math.max(remainingPayment, 0) };
}
