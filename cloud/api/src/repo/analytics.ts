export interface CurrencyAmountDto {
  currencyCode: string;
  amount: number;
}

export interface SalesSummaryDto {
  currencyCode: string;
  saleCount: number;
  totalCashValue: number;
  totalMarkup: number;
  totalInstallmentValue: number;
  totalCollected: number;
  totalOutstanding: number;
}

/**
 * Sales and profit totals per currency for sales made within
 * [fromDate, toDate] (either bound optional). Collected/outstanding
 * reflect the current state of those sales' installments regardless of
 * when any payment landed. Ported from analytics.rs::get_sales_summary.
 */
export async function getSalesSummary(db: D1Database, fromDate?: string, toDate?: string): Promise<SalesSummaryDto[]> {
  const saleTotals = await db
    .prepare(
      `SELECT currency_code, COUNT(*) AS count,
              SUM(total_installment_price - applied_markup_value) AS cash,
              SUM(applied_markup_value) AS markup,
              SUM(total_installment_price) AS installment_value
       FROM credit_sale
       WHERE (?1 IS NULL OR sale_date >= ?1) AND (?2 IS NULL OR sale_date <= ?2)
       GROUP BY currency_code`,
    )
    .bind(fromDate ?? null, toDate ?? null)
    .all<{ currency_code: string; count: number; cash: number; markup: number; installment_value: number }>();

  const collectedResult = await db
    .prepare(
      `SELECT cs.currency_code,
              SUM(COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0)) AS allocated
       FROM installment i
       JOIN credit_sale cs ON cs.id = i.sale_id
       WHERE (?1 IS NULL OR cs.sale_date >= ?1) AND (?2 IS NULL OR cs.sale_date <= ?2)
       GROUP BY cs.currency_code`,
    )
    .bind(fromDate ?? null, toDate ?? null)
    .all<{ currency_code: string; allocated: number }>();
  const collectedByCurrency = new Map(collectedResult.results.map((r) => [r.currency_code, r.allocated]));

  return saleTotals.results.map((t) => {
    const collected = collectedByCurrency.get(t.currency_code) ?? 0;
    return {
      currencyCode: t.currency_code,
      saleCount: t.count,
      totalCashValue: t.cash,
      totalMarkup: t.markup,
      totalInstallmentValue: t.installment_value,
      totalCollected: collected,
      totalOutstanding: t.installment_value - collected,
    };
  });
}

export interface ProductSalesDto {
  productId: string;
  productName: string;
  totalQuantity: number;
  revenueByCurrency: CurrencyAmountDto[];
}

/** Top `limit` products by total quantity sold, revenue broken down by currency (not counting markup). */
export async function getTopProducts(db: D1Database, limit: number): Promise<ProductSalesDto[]> {
  const ranking = await db
    .prepare(
      `SELECT p.id, p.name, SUM(ci.quantity) AS total_quantity
       FROM credit_sale_item ci
       JOIN product p ON p.id = ci.product_id
       GROUP BY p.id, p.name
       ORDER BY SUM(ci.quantity) DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; name: string; total_quantity: number }>();

  const result: ProductSalesDto[] = [];
  for (const row of ranking.results) {
    const revenue = await db
      .prepare(
        `SELECT cs.currency_code, SUM(ci.snapshot_cash_price * ci.quantity) AS amount
         FROM credit_sale_item ci
         JOIN credit_sale cs ON cs.id = ci.sale_id
         WHERE ci.product_id = ?1
         GROUP BY cs.currency_code`,
      )
      .bind(row.id)
      .all<{ currency_code: string; amount: number }>();
    result.push({
      productId: row.id,
      productName: row.name,
      totalQuantity: row.total_quantity,
      revenueByCurrency: revenue.results.map((r) => ({ currencyCode: r.currency_code, amount: r.amount })),
    });
  }
  return result;
}

export interface CustomerRankingDto {
  customerId: string;
  customerName: string;
  saleCount: number;
  totalPurchasedByCurrency: CurrencyAmountDto[];
}

/** Top `limit` customers by number of completed sales. */
export async function getTopCustomers(db: D1Database, limit: number): Promise<CustomerRankingDto[]> {
  const ranking = await db
    .prepare(
      `SELECT c.id, c.name, COUNT(cs.id) AS sale_count
       FROM customer c
       JOIN credit_sale cs ON cs.customer_id = c.id
       GROUP BY c.id, c.name
       ORDER BY COUNT(cs.id) DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; name: string; sale_count: number }>();

  const result: CustomerRankingDto[] = [];
  for (const row of ranking.results) {
    const totals = await db
      .prepare("SELECT currency_code, SUM(total_installment_price) AS amount FROM credit_sale WHERE customer_id = ?1 GROUP BY currency_code")
      .bind(row.id)
      .all<{ currency_code: string; amount: number }>();
    result.push({
      customerId: row.id,
      customerName: row.name,
      saleCount: row.sale_count,
      totalPurchasedByCurrency: totals.results.map((r) => ({ currencyCode: r.currency_code, amount: r.amount })),
    });
  }
  return result;
}

export interface CustomerOverdueRankingDto {
  customerId: string;
  customerName: string;
  overdueInstallmentCount: number;
  maxDaysOverdue: number;
  overdueAmountByCurrency: CurrencyAmountDto[];
}

function daysBetween(today: string, dueDate: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/**
 * Top `limit` customers by how overdue they are, ranked by the longest
 * any single installment of theirs has been overdue. Ported from
 * analytics.rs::get_most_overdue_customers.
 */
export async function getMostOverdueCustomers(db: D1Database, currentDate: string, limit: number): Promise<CustomerOverdueRankingDto[]> {
  const result = await db
    .prepare(
      `SELECT customer_id, customer_name, currency_code, due_date, remaining
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
       WHERE remaining > 0`,
    )
    .bind(currentDate)
    .all<{ customer_id: string; customer_name: string; currency_code: string; due_date: string; remaining: number }>();

  const byCustomer = new Map<string, { customerName: string; rows: { currency: string; daysOverdue: number; remaining: number }[] }>();
  for (const row of result.results) {
    const daysOverdue = daysBetween(currentDate, row.due_date);
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, { customerName: row.customer_name, rows: [] });
    byCustomer.get(row.customer_id)!.rows.push({ currency: row.currency_code, daysOverdue, remaining: row.remaining });
  }

  const ranked: CustomerOverdueRankingDto[] = [];
  for (const [customerId, { customerName, rows }] of byCustomer) {
    const maxDaysOverdue = Math.max(...rows.map((r) => r.daysOverdue));
    const overdueAmountByCurrency: CurrencyAmountDto[] = [];
    for (const row of rows) {
      const existing = overdueAmountByCurrency.find((c) => c.currencyCode === row.currency);
      if (existing) existing.amount += row.remaining;
      else overdueAmountByCurrency.push({ currencyCode: row.currency, amount: row.remaining });
    }
    ranked.push({ customerId, customerName, overdueInstallmentCount: rows.length, maxDaysOverdue, overdueAmountByCurrency });
  }

  ranked.sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);
  return ranked.slice(0, Math.max(limit, 0));
}

export interface CustomerOverviewDto {
  customerId: string;
  customerName: string;
  saleCount: number;
  totalPurchasedByCurrency: CurrencyAmountDto[];
  totalRemainingByCurrency: CurrencyAmountDto[];
  lastSaleDate: string | null;
}

/**
 * Every customer with their activity summary. Customers with no sales
 * still appear, with empty totals. Ported from
 * analytics.rs::get_customers_overview.
 */
export async function getCustomersOverview(db: D1Database): Promise<CustomerOverviewDto[]> {
  const customers = await db
    .prepare(
      `SELECT c.id, c.name, COUNT(cs.id) AS sale_count, MAX(cs.sale_date) AS last_sale_date
       FROM customer c
       LEFT JOIN credit_sale cs ON cs.customer_id = c.id
       GROUP BY c.id, c.name
       ORDER BY c.name`,
    )
    .all<{ id: string; name: string; sale_count: number; last_sale_date: string | null }>();

  const result: CustomerOverviewDto[] = [];
  for (const row of customers.results) {
    const purchased = await db
      .prepare("SELECT currency_code, SUM(total_installment_price) AS amount FROM credit_sale WHERE customer_id = ?1 GROUP BY currency_code")
      .bind(row.id)
      .all<{ currency_code: string; amount: number }>();
    const remaining = await db
      .prepare(
        `SELECT cs.currency_code,
                SUM(i.scheduled_amount) - SUM(COALESCE(
                    (SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0
                )) AS amount
         FROM installment i
         JOIN credit_sale cs ON cs.id = i.sale_id
         WHERE cs.customer_id = ?1
         GROUP BY cs.currency_code`,
      )
      .bind(row.id)
      .all<{ currency_code: string; amount: number }>();

    result.push({
      customerId: row.id,
      customerName: row.name,
      saleCount: row.sale_count,
      totalPurchasedByCurrency: purchased.results.map((r) => ({ currencyCode: r.currency_code, amount: r.amount })),
      totalRemainingByCurrency: remaining.results.map((r) => ({ currencyCode: r.currency_code, amount: r.amount })),
      lastSaleDate: row.last_sale_date,
    });
  }
  return result;
}
