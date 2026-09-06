import { allocatePayment, type OutstandingInstallment } from "../engine";
import { ApiError, auditInsertStatement, auditUpdateStatement, newId } from "../db";

export interface CreatePaymentPayload {
  customerId: string;
  saleId?: string | null;
  paymentDate: string;
  amountPaid: number;
  currencyCode: string;
  manualExchangeRateMicros: number;
}

export interface PaymentAllocationDto {
  id: string;
  paymentId: string;
  installmentId: string;
  allocatedAmount: number;
}

export interface PaymentDto {
  id: string;
  customerId: string;
  paymentDate: string;
  amountPaid: number;
  currencyCode: string;
  manualExchangeRateMicros: number;
  createdAt: string;
  allocations: PaymentAllocationDto[];
  unallocatedAmount: number;
}

/**
 * Registers a Payment and allocates it oldest-due-date-first across the
 * customer's outstanding installments -- across all of the customer's
 * sales by default, or scoped to a single CreditSale when `saleId` is
 * set -- regardless of currency, atomically. Ported from
 * repo/payment.rs::register_payment.
 */
export async function registerPayment(db: D1Database, payload: CreatePaymentPayload): Promise<PaymentDto> {
  if (payload.amountPaid <= 0) throw new ApiError(400, "amount_paid must be positive");
  if (payload.manualExchangeRateMicros <= 0) throw new ApiError(400, "manual_exchange_rate_micros must be positive");

  const paymentId = newId();
  const createdAt = new Date().toISOString();

  const outstandingResult = await db
    .prepare(
      `SELECT i.id, i.scheduled_amount,
              COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0) AS already_allocated,
              cs.currency_code
       FROM installment i
       JOIN credit_sale cs ON cs.id = i.sale_id
       WHERE cs.customer_id = ?1 AND (?2 IS NULL OR cs.id = ?2) AND i.status != 'Paid'
       ORDER BY i.due_date ASC, i.id ASC`,
    )
    .bind(payload.customerId, payload.saleId ?? null)
    .all<{ id: string; scheduled_amount: number; already_allocated: number; currency_code: string }>();

  const outstanding = outstandingResult.results;
  const engineInput: OutstandingInstallment[] = outstanding.map((o) => ({
    id: o.id,
    remaining: o.scheduled_amount - o.already_allocated,
    currency: o.currency_code,
  }));

  const { allocations, unallocatedAmount } = allocatePayment(
    payload.amountPaid,
    payload.currencyCode,
    payload.manualExchangeRateMicros,
    engineInput,
  );

  const statements = [
    db
      .prepare(
        "INSERT INTO payment (id, customer_id, payment_date, amount_paid, currency_code, manual_exchange_rate_micros, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(paymentId, payload.customerId, payload.paymentDate, payload.amountPaid, payload.currencyCode, payload.manualExchangeRateMicros, createdAt),
  ];

  const allocationDtos: PaymentAllocationDto[] = [];
  for (const allocation of allocations) {
    const id = newId();
    statements.push(
      db
        .prepare("INSERT INTO payment_allocation (id, payment_id, installment_id, allocated_amount) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, paymentId, allocation.installmentId, allocation.amount),
    );
    allocationDtos.push({ id, paymentId, installmentId: allocation.installmentId, allocatedAmount: allocation.amount });

    const outstandingRow = outstanding.find((o) => o.id === allocation.installmentId)!;
    const newAllocatedTotal = outstandingRow.already_allocated + allocation.amount;
    const oldStatus = outstandingRow.already_allocated === 0 ? "Pending" : "Partial";
    const newStatus = newAllocatedTotal >= outstandingRow.scheduled_amount ? "Paid" : "Partial";

    if (newStatus !== oldStatus) {
      statements.push(db.prepare("UPDATE installment SET status = ?1 WHERE id = ?2").bind(newStatus, allocation.installmentId));
      statements.push(
        auditUpdateStatement(db, "installment", allocation.installmentId, { status: oldStatus }, { status: newStatus }),
      );
    }
  }

  const dto: PaymentDto = {
    id: paymentId,
    customerId: payload.customerId,
    paymentDate: payload.paymentDate,
    amountPaid: payload.amountPaid,
    currencyCode: payload.currencyCode,
    manualExchangeRateMicros: payload.manualExchangeRateMicros,
    createdAt,
    allocations: allocationDtos,
    unallocatedAmount,
  };
  statements.push(auditInsertStatement(db, "payment", paymentId, dto));

  await db.batch(statements);
  return dto;
}

/** Lists a customer's payments, newest first, each with its allocations inlined. */
export async function getPaymentsForCustomer(db: D1Database, customerId: string): Promise<PaymentDto[]> {
  const paymentsResult = await db
    .prepare(
      `SELECT id, customer_id, payment_date, amount_paid, currency_code, manual_exchange_rate_micros, created_at
       FROM payment WHERE customer_id = ?1 ORDER BY payment_date DESC, id DESC`,
    )
    .bind(customerId)
    .all<{ id: string; customer_id: string; payment_date: string; amount_paid: number; currency_code: string; manual_exchange_rate_micros: number; created_at: string }>();

  const payments: PaymentDto[] = paymentsResult.results.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    paymentDate: row.payment_date,
    amountPaid: row.amount_paid,
    currencyCode: row.currency_code,
    manualExchangeRateMicros: row.manual_exchange_rate_micros,
    createdAt: row.created_at,
    allocations: [],
    // Not reconstructed for historical listings -- reported once at
    // creation time, and there's no cached balance to look up later.
    unallocatedAmount: 0,
  }));

  for (const payment of payments) {
    const allocResult = await db
      .prepare("SELECT id, payment_id, installment_id, allocated_amount FROM payment_allocation WHERE payment_id = ?1")
      .bind(payment.id)
      .all<{ id: string; payment_id: string; installment_id: string; allocated_amount: number }>();
    payment.allocations = allocResult.results.map((row) => ({
      id: row.id,
      paymentId: row.payment_id,
      installmentId: row.installment_id,
      allocatedAmount: row.allocated_amount,
    }));
  }

  return payments;
}
