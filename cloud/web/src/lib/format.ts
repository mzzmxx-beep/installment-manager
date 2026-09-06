import type { CurrencyAmount, CurrencyCode } from "@/lib/api";

/** Formats an integer storage amount (USD cents / exact IQD) into a display string. */
export function formatMoney(amount: number, currency: CurrencyCode): string {
  if (currency === "USD") {
    return (amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  return `${amount.toLocaleString("en-US")} د.ع`;
}

/** Formats a list of per-currency amounts, e.g. from analytics/report DTOs. */
export function formatAmounts(amounts: CurrencyAmount[]): string {
  if (amounts.length === 0) return "—";
  return amounts.map((a) => formatMoney(a.amount, a.currency_code)).join("، ");
}

/** Formats a `*_exchange_rate_micros` column (IQD per 1 USD, ×1,000,000) as a plain decimal rate. */
export function formatRate(rateMicros: number): string {
  return (rateMicros / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Converts a user-typed decimal string in display units into the integer storage unit. */
export function toStorageAmount(value: string, currency: CurrencyCode): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return currency === "USD" ? Math.round(n * 100) : Math.round(n);
}

/** Shortens a UUID for display (e.g. invoice numbers) -- not unique on its own, only a human-friendly reference alongside the date. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mirrors the backend's `engine::convert_currency` for live previews only —
 * the authoritative amount is always recomputed server-side on save.
 * `rateMicros` is IQD per 1 USD, scaled by 1,000,000.
 */
export function convertCurrency(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rateMicros: number,
): number {
  if (from === to) return amount;
  if (from === "USD" && to === "IQD") return Math.round((amount * rateMicros) / 100_000_000);
  if (from === "IQD" && to === "USD") return Math.round((amount * 100_000_000) / rateMicros);
  return amount;
}
