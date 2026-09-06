// Reports that "explain" currency conversion: every place convertCurrency
// actually ran, broken down per invoice, per payment, per product, and
// per customer. Ported from repo/currency_report.rs.
//
// credit_sale_item has no column for the pre-conversion (original
// currency) unit price -- only the post-conversion snapshot_cash_price is
// stored, in the sale's own currency. This reconstructs the original
// amount by inverse-converting that snapshot back through the same
// sale-level rate and the product's *current* currency_code. Exact as
// long as a product's currency never changes after creation (true today
// -- there is no edit-product endpoint).

import { convertCurrency } from "../engine";
import type { CurrencyAmountDto } from "./analytics";

function addAmount(list: CurrencyAmountDto[], currency: string, amount: number) {
  const existing = list.find((c) => c.currencyCode === currency);
  if (existing) existing.amount += amount;
  else list.push({ currencyCode: currency, amount });
}

export interface SaleConversionItemDto {
  productId: string;
  productName: string;
  originalCurrency: string;
  originalUnitPrice: number;
  convertedCurrency: string;
  convertedUnitPrice: number;
  quantity: number;
  exchangeRateMicros: number;
}

export interface SaleConversionDto {
  saleId: string;
  saleDate: string;
  customerId: string;
  customerName: string;
  saleCurrency: string;
  items: SaleConversionItemDto[];
}

/**
 * Per-invoice detail: only sale items whose product currency differs
 * from the sale's own currency are included.
 */
export async function getSaleConversions(db: D1Database, fromDate?: string, toDate?: string): Promise<SaleConversionDto[]> {
  const result = await db
    .prepare(
      `SELECT cs.id AS sale_id, cs.sale_date, cs.customer_id, c.name AS customer_name, cs.currency_code AS sale_currency,
              cs.manual_exchange_rate_micros AS rate_micros, p.id AS product_id, p.name AS product_name,
              p.currency_code AS product_currency, ci.snapshot_cash_price, ci.quantity
       FROM credit_sale_item ci
       JOIN credit_sale cs ON cs.id = ci.sale_id
       JOIN product p ON p.id = ci.product_id
       JOIN customer c ON c.id = cs.customer_id
       WHERE p.currency_code != cs.currency_code
         AND (?1 IS NULL OR cs.sale_date >= ?1) AND (?2 IS NULL OR cs.sale_date <= ?2)
       ORDER BY cs.sale_date DESC, cs.id DESC, ci.id ASC`,
    )
    .bind(fromDate ?? null, toDate ?? null)
    .all<{
      sale_id: string;
      sale_date: string;
      customer_id: string;
      customer_name: string;
      sale_currency: string;
      rate_micros: number;
      product_id: string;
      product_name: string;
      product_currency: string;
      snapshot_cash_price: number;
      quantity: number;
    }>();

  const sales: SaleConversionDto[] = [];
  for (const row of result.results) {
    const originalUnitPrice = convertCurrency(row.snapshot_cash_price, row.sale_currency, row.product_currency, row.rate_micros);
    const item: SaleConversionItemDto = {
      productId: row.product_id,
      productName: row.product_name,
      originalCurrency: row.product_currency,
      originalUnitPrice,
      convertedCurrency: row.sale_currency,
      convertedUnitPrice: row.snapshot_cash_price,
      quantity: row.quantity,
      exchangeRateMicros: row.rate_micros,
    };
    const last = sales[sales.length - 1];
    if (last && last.saleId === row.sale_id) {
      last.items.push(item);
    } else {
      sales.push({
        saleId: row.sale_id,
        saleDate: row.sale_date,
        customerId: row.customer_id,
        customerName: row.customer_name,
        saleCurrency: row.sale_currency,
        items: [item],
      });
    }
  }
  return sales;
}

export interface PaymentConversionDto {
  paymentId: string;
  paymentDate: string;
  customerId: string;
  customerName: string;
  paymentCurrency: string;
  amountPaid: number;
  exchangeRateMicros: number;
  convertedByCurrency: CurrencyAmountDto[];
}

/**
 * Every payment that landed (at least partly) in a currency other than
 * its own. Only two currencies exist in this app, so convertedByCurrency
 * always has exactly one entry.
 */
export async function getPaymentConversions(db: D1Database, fromDate?: string, toDate?: string): Promise<PaymentConversionDto[]> {
  const result = await db
    .prepare(
      `SELECT pay.id AS payment_id, pay.payment_date, pay.customer_id, c.name AS customer_name, pay.currency_code AS payment_currency,
              pay.amount_paid, pay.manual_exchange_rate_micros AS rate_micros, cs.currency_code AS target_currency,
              SUM(pa.allocated_amount) AS allocated
       FROM payment pay
       JOIN customer c ON c.id = pay.customer_id
       JOIN payment_allocation pa ON pa.payment_id = pay.id
       JOIN installment i ON i.id = pa.installment_id
       JOIN credit_sale cs ON cs.id = i.sale_id
       WHERE cs.currency_code != pay.currency_code
         AND (?1 IS NULL OR pay.payment_date >= ?1) AND (?2 IS NULL OR pay.payment_date <= ?2)
       GROUP BY pay.id, cs.currency_code
       ORDER BY pay.payment_date DESC, pay.id DESC`,
    )
    .bind(fromDate ?? null, toDate ?? null)
    .all<{
      payment_id: string;
      payment_date: string;
      customer_id: string;
      customer_name: string;
      payment_currency: string;
      amount_paid: number;
      rate_micros: number;
      target_currency: string;
      allocated: number;
    }>();

  return result.results.map((row) => ({
    paymentId: row.payment_id,
    paymentDate: row.payment_date,
    customerId: row.customer_id,
    customerName: row.customer_name,
    paymentCurrency: row.payment_currency,
    amountPaid: row.amount_paid,
    exchangeRateMicros: row.rate_micros,
    convertedByCurrency: [{ currencyCode: row.target_currency, amount: row.allocated }],
  }));
}

export interface ProductConversionSummaryDto {
  productId: string;
  productName: string;
  conversionCount: number;
  originalValueByCurrency: CurrencyAmountDto[];
  convertedValueByCurrency: CurrencyAmountDto[];
}

/** Per-product rollup of every sale-item conversion it was part of. */
export async function getProductConversionSummary(db: D1Database): Promise<ProductConversionSummaryDto[]> {
  const result = await db
    .prepare(
      `SELECT p.id AS product_id, p.name AS product_name, cs.currency_code AS sale_currency, p.currency_code AS product_currency,
              cs.manual_exchange_rate_micros AS rate_micros, ci.snapshot_cash_price, ci.quantity
       FROM credit_sale_item ci
       JOIN credit_sale cs ON cs.id = ci.sale_id
       JOIN product p ON p.id = ci.product_id
       WHERE p.currency_code != cs.currency_code`,
    )
    .all<{ product_id: string; product_name: string; sale_currency: string; product_currency: string; rate_micros: number; snapshot_cash_price: number; quantity: number }>();

  const byProduct = new Map<string, { productName: string; count: number; original: CurrencyAmountDto[]; converted: CurrencyAmountDto[] }>();
  for (const row of result.results) {
    const originalUnitPrice = convertCurrency(row.snapshot_cash_price, row.sale_currency, row.product_currency, row.rate_micros);
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, { productName: row.product_name, count: 0, original: [], converted: [] });
    }
    const entry = byProduct.get(row.product_id)!;
    entry.count += 1;
    addAmount(entry.original, row.product_currency, originalUnitPrice * row.quantity);
    addAmount(entry.converted, row.sale_currency, row.snapshot_cash_price * row.quantity);
  }

  const summary: ProductConversionSummaryDto[] = Array.from(byProduct.entries()).map(([productId, acc]) => ({
    productId,
    productName: acc.productName,
    conversionCount: acc.count,
    originalValueByCurrency: acc.original,
    convertedValueByCurrency: acc.converted,
  }));
  summary.sort((a, b) => a.productName.localeCompare(b.productName));
  return summary;
}

export interface CustomerConversionSummaryDto {
  customerId: string;
  customerName: string;
  itemConversionCount: number;
  itemOriginalValueByCurrency: CurrencyAmountDto[];
  itemConvertedValueByCurrency: CurrencyAmountDto[];
  paymentConversionCount: number;
  paymentConvertedValueByCurrency: CurrencyAmountDto[];
}

/** Per-customer rollup combining both conversion sources (sale items and payments). */
export async function getCustomerConversionSummary(db: D1Database): Promise<CustomerConversionSummaryDto[]> {
  const itemRows = await db
    .prepare(
      `SELECT cs.customer_id, c.name AS customer_name, cs.currency_code AS sale_currency, p.currency_code AS product_currency,
              cs.manual_exchange_rate_micros AS rate_micros, ci.snapshot_cash_price, ci.quantity
       FROM credit_sale_item ci
       JOIN credit_sale cs ON cs.id = ci.sale_id
       JOIN product p ON p.id = ci.product_id
       JOIN customer c ON c.id = cs.customer_id
       WHERE p.currency_code != cs.currency_code`,
    )
    .all<{ customer_id: string; customer_name: string; sale_currency: string; product_currency: string; rate_micros: number; snapshot_cash_price: number; quantity: number }>();

  const paymentRows = await db
    .prepare(
      `SELECT pay.customer_id, c.name AS customer_name, cs.currency_code AS target_currency, SUM(pa.allocated_amount) AS allocated
       FROM payment pay
       JOIN customer c ON c.id = pay.customer_id
       JOIN payment_allocation pa ON pa.payment_id = pay.id
       JOIN installment i ON i.id = pa.installment_id
       JOIN credit_sale cs ON cs.id = i.sale_id
       WHERE cs.currency_code != pay.currency_code
       GROUP BY pay.id, cs.currency_code`,
    )
    .all<{ customer_id: string; customer_name: string; target_currency: string; allocated: number }>();

  interface Acc {
    customerName: string;
    itemCount: number;
    itemOriginal: CurrencyAmountDto[];
    itemConverted: CurrencyAmountDto[];
    paymentCount: number;
    paymentConverted: CurrencyAmountDto[];
  }
  const byCustomer = new Map<string, Acc>();
  const getOrInit = (customerId: string, customerName: string): Acc => {
    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, { customerName, itemCount: 0, itemOriginal: [], itemConverted: [], paymentCount: 0, paymentConverted: [] });
    }
    return byCustomer.get(customerId)!;
  };

  for (const row of itemRows.results) {
    const originalUnitPrice = convertCurrency(row.snapshot_cash_price, row.sale_currency, row.product_currency, row.rate_micros);
    const entry = getOrInit(row.customer_id, row.customer_name);
    entry.itemCount += 1;
    addAmount(entry.itemOriginal, row.product_currency, originalUnitPrice * row.quantity);
    addAmount(entry.itemConverted, row.sale_currency, row.snapshot_cash_price * row.quantity);
  }

  for (const row of paymentRows.results) {
    const entry = getOrInit(row.customer_id, row.customer_name);
    entry.paymentCount += 1;
    addAmount(entry.paymentConverted, row.target_currency, row.allocated);
  }

  const summary: CustomerConversionSummaryDto[] = Array.from(byCustomer.entries()).map(([customerId, acc]) => ({
    customerId,
    customerName: acc.customerName,
    itemConversionCount: acc.itemCount,
    itemOriginalValueByCurrency: acc.itemOriginal,
    itemConvertedValueByCurrency: acc.itemConverted,
    paymentConversionCount: acc.paymentCount,
    paymentConvertedValueByCurrency: acc.paymentConverted,
  }));
  summary.sort((a, b) => a.customerName.localeCompare(b.customerName));
  return summary;
}
