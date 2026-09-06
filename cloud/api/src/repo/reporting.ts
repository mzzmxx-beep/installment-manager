import { ApiError } from "../db";
import * as customerRepo from "./customer";
import { getSalesForCustomer, type CreditSaleDto } from "./sale";
import { getPaymentsForCustomer, type PaymentDto } from "./payment";

export interface CurrencyBalanceDto {
  currencyCode: string;
  totalRemaining: number;
}

export interface CustomerStatementDto {
  customer: customerRepo.CustomerDto;
  sales: CreditSaleDto[];
  payments: PaymentDto[];
  balances: CurrencyBalanceDto[];
}

/**
 * Full transaction history and derived balance for one customer. Balances
 * are computed fresh from outstanding installments across all of the
 * customer's sales -- never read from a cached column. Ported from
 * repo/reporting.rs::get_customer_statement.
 */
export async function getCustomerStatement(db: D1Database, customerId: string): Promise<CustomerStatementDto> {
  const customerRow = await db
    .prepare("SELECT id, name, phone, national_id, address, created_at FROM customer WHERE id = ?1")
    .bind(customerId)
    .first();
  if (!customerRow) throw new ApiError(404, `customer ${customerId} not found`);
  const customer: customerRepo.CustomerDto = {
    id: customerRow.id as string,
    name: customerRow.name as string,
    phone: (customerRow.phone as string | null) ?? null,
    nationalId: customerRow.national_id as string,
    address: (customerRow.address as string | null) ?? null,
    createdAt: customerRow.created_at as string,
  };

  const sales = await getSalesForCustomer(db, customerId);
  const payments = await getPaymentsForCustomer(db, customerId);

  const balances: CurrencyBalanceDto[] = [];
  for (const sale of sales) {
    const remaining = sale.installments.reduce((sum, i) => sum + i.remainingAmount, 0);
    if (remaining === 0) continue;
    const existing = balances.find((b) => b.currencyCode === sale.currencyCode);
    if (existing) existing.totalRemaining += remaining;
    else balances.push({ currencyCode: sale.currencyCode, totalRemaining: remaining });
  }

  return { customer, sales, payments, balances };
}

export interface OverdueInstallmentDto {
  installmentId: string;
  saleId: string;
  customerId: string;
  customerName: string;
  dueDate: string;
  daysOverdue: number;
  currencyCode: string;
  scheduledAmount: number;
  remainingAmount: number;
}

function daysBetween(today: string, dueDate: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/**
 * Every installment overdue as of `currentDate` across all customers:
 * due_date < currentDate and still short of scheduled_amount, ordered
 * most-overdue-first. Remaining amounts are always derived from
 * payment_allocation, not the cached `status` column. Ported from
 * repo/reporting.rs::get_overdue_installments.
 */
export async function getOverdueInstallments(db: D1Database, currentDate: string): Promise<OverdueInstallmentDto[]> {
  const result = await db
    .prepare(
      `SELECT id, sale_id, customer_id, customer_name, due_date, currency_code, scheduled_amount, remaining
       FROM (
           SELECT i.id, i.sale_id, cs.customer_id, c.name AS customer_name, i.due_date,
                  cs.currency_code, i.scheduled_amount,
                  i.scheduled_amount - COALESCE(
                      (SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0
                  ) AS remaining
           FROM installment i
           JOIN credit_sale cs ON cs.id = i.sale_id
           JOIN customer c ON c.id = cs.customer_id
           WHERE i.due_date < ?1
       )
       WHERE remaining > 0
       ORDER BY due_date ASC`,
    )
    .bind(currentDate)
    .all<{
      id: string;
      sale_id: string;
      customer_id: string;
      customer_name: string;
      due_date: string;
      currency_code: string;
      scheduled_amount: number;
      remaining: number;
    }>();

  return result.results.map((row) => ({
    installmentId: row.id,
    saleId: row.sale_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    dueDate: row.due_date,
    daysOverdue: daysBetween(currentDate, row.due_date),
    currencyCode: row.currency_code,
    scheduledAmount: row.scheduled_amount,
    remainingAmount: row.remaining,
  }));
}
