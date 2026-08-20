import type { CurrencyCode } from "@/lib/api";

/** Formats an integer storage amount (USD cents / exact IQD) into a display string. */
export function formatMoney(amount: number, currency: CurrencyCode): string {
  if (currency === "USD") {
    return (amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  return `${amount.toLocaleString("en-US")} د.ع`;
}

/** Converts a user-typed decimal string in display units into the integer storage unit. */
export function toStorageAmount(value: string, currency: CurrencyCode): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return currency === "USD" ? Math.round(n * 100) : Math.round(n);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
