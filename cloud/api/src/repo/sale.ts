import { convertCurrency, generateSchedule, resolveMarkup, type MarkupType, type PeriodUnit } from "../engine";
import { ApiError, auditInsertStatement, newId } from "../db";

export interface CreditSaleItemInput {
  productId: string;
  quantity: number;
}

export interface CreateCreditSalePayload {
  customerId: string;
  guarantorId?: string | null;
  saleDate: string; // YYYY-MM-DD
  items: CreditSaleItemInput[];
  markupType: MarkupType;
  markupInput: number;
  agreedMonths: number;
  installmentPeriodUnit: PeriodUnit;
  currencyCode: string;
  manualExchangeRateMicros: number;
}

export interface CreditSaleItemDto {
  id: string;
  saleId: string;
  productId: string;
  productName: string;
  snapshotCashPrice: number;
  quantity: number;
}

export interface InstallmentDto {
  id: string;
  saleId: string;
  dueDate: string;
  scheduledAmount: number;
  allocatedAmount: number;
  remainingAmount: number;
  status: "Pending" | "Partial" | "Paid";
}

export interface CreditSaleDto {
  id: string;
  customerId: string;
  guarantorId: string | null;
  guarantorName: string | null;
  saleDate: string;
  agreedMonths: number;
  installmentPeriodUnit: PeriodUnit;
  appliedMarkupValue: number;
  totalInstallmentPrice: number;
  currencyCode: string;
  manualExchangeRateMicros: number;
  createdAt: string;
  items: CreditSaleItemDto[];
  installments: InstallmentDto[];
}

/**
 * Creates a CreditSale and its items/installments atomically (a
 * half-written sale must never be observable). Ported from
 * repo/sale.rs::create_credit_sale.
 */
export async function createCreditSale(db: D1Database, payload: CreateCreditSalePayload): Promise<CreditSaleDto> {
  if (payload.items.length === 0) throw new ApiError(400, "a sale must have at least one item");
  if (payload.manualExchangeRateMicros <= 0) throw new ApiError(400, "manual_exchange_rate_micros must be positive");
  if (payload.guarantorId && payload.guarantorId === payload.customerId) {
    throw new ApiError(400, "a customer cannot guarantee their own sale");
  }
  if (payload.installmentPeriodUnit !== "months" && payload.installmentPeriodUnit !== "days") {
    throw new ApiError(400, `invalid installment_period_unit: ${payload.installmentPeriodUnit}`);
  }

  let cashTotal = 0;
  const itemRows: { productId: string; productName: string; unitPrice: number; quantity: number }[] = [];
  for (const item of payload.items) {
    if (item.quantity <= 0) throw new ApiError(400, "item quantity must be positive");
    const product = await db
      .prepare("SELECT name, reference_cash_price, currency_code, is_active FROM product WHERE id = ?1")
      .bind(item.productId)
      .first<{ name: string; reference_cash_price: number; currency_code: string; is_active: number }>();
    if (!product) throw new ApiError(404, `product ${item.productId} not found`);
    if (product.is_active === 0) throw new ApiError(400, `product ${item.productId} is not active`);

    // Products may be priced in either currency; snapshot the unit price
    // converted into the sale's own currency so every item on a sale is
    // directly summable.
    const unitPrice = convertCurrency(
      product.reference_cash_price,
      product.currency_code,
      payload.currencyCode,
      payload.manualExchangeRateMicros,
    );
    cashTotal += unitPrice * item.quantity;
    itemRows.push({ productId: item.productId, productName: product.name, unitPrice, quantity: item.quantity });
  }

  const appliedMarkupValue = resolveMarkup(cashTotal, payload.markupType, payload.markupInput);
  const totalInstallmentPrice = cashTotal + appliedMarkupValue;
  if (totalInstallmentPrice <= 0) throw new ApiError(400, "total installment price must be positive");

  const saleId = newId();
  const createdAt = new Date().toISOString();

  const statements = [
    db
      .prepare(
        `INSERT INTO credit_sale (
           id, customer_id, guarantor_id, sale_date, agreed_months, installment_period_unit,
           applied_markup_value, total_installment_price, currency_code, manual_exchange_rate_micros, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        saleId,
        payload.customerId,
        payload.guarantorId ?? null,
        payload.saleDate,
        payload.agreedMonths,
        payload.installmentPeriodUnit,
        appliedMarkupValue,
        totalInstallmentPrice,
        payload.currencyCode,
        payload.manualExchangeRateMicros,
        createdAt,
      ),
  ];

  const items: CreditSaleItemDto[] = itemRows.map((row) => {
    const id = newId();
    statements.push(
      db
        .prepare("INSERT INTO credit_sale_item (id, sale_id, product_id, snapshot_cash_price, quantity) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(id, saleId, row.productId, row.unitPrice, row.quantity),
    );
    return { id, saleId, productId: row.productId, productName: row.productName, snapshotCashPrice: row.unitPrice, quantity: row.quantity };
  });

  const schedule = generateSchedule(totalInstallmentPrice, payload.agreedMonths, payload.saleDate, payload.installmentPeriodUnit);
  const installments: InstallmentDto[] = schedule.map((scheduled) => {
    const id = newId();
    statements.push(
      db
        .prepare("INSERT INTO installment (id, sale_id, due_date, scheduled_amount) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, saleId, scheduled.dueDate, scheduled.amount),
    );
    return {
      id,
      saleId,
      dueDate: scheduled.dueDate,
      scheduledAmount: scheduled.amount,
      allocatedAmount: 0,
      remainingAmount: scheduled.amount,
      status: "Pending",
    };
  });

  let guarantorName: string | null = null;
  if (payload.guarantorId) {
    const guarantor = await db.prepare("SELECT name FROM customer WHERE id = ?1").bind(payload.guarantorId).first<{ name: string }>();
    if (!guarantor) throw new ApiError(404, `guarantor ${payload.guarantorId} not found`);
    guarantorName = guarantor.name;
  }

  const dto: CreditSaleDto = {
    id: saleId,
    customerId: payload.customerId,
    guarantorId: payload.guarantorId ?? null,
    guarantorName,
    saleDate: payload.saleDate,
    agreedMonths: payload.agreedMonths,
    installmentPeriodUnit: payload.installmentPeriodUnit,
    appliedMarkupValue,
    totalInstallmentPrice,
    currencyCode: payload.currencyCode,
    manualExchangeRateMicros: payload.manualExchangeRateMicros,
    createdAt,
    items,
    installments,
  };

  statements.push(auditInsertStatement(db, "credit_sale", saleId, dto));

  // D1's batch() runs every statement as a single atomic transaction --
  // the equivalent of the Rust version's rusqlite `tx.commit()`.
  await db.batch(statements);
  return dto;
}

/**
 * Lists a customer's sales with items and installments inlined, each
 * installment's allocated/remaining amount derived live from
 * payment_allocation (never a stored balance column).
 */
export async function getSalesForCustomer(db: D1Database, customerId: string): Promise<CreditSaleDto[]> {
  const salesResult = await db
    .prepare(
      `SELECT cs.id, cs.customer_id, cs.guarantor_id, cs.sale_date, cs.agreed_months, cs.applied_markup_value,
              cs.total_installment_price, cs.currency_code, cs.manual_exchange_rate_micros, cs.created_at,
              g.name AS guarantor_name, cs.installment_period_unit
       FROM credit_sale cs
       LEFT JOIN customer g ON g.id = cs.guarantor_id
       WHERE cs.customer_id = ?1
       ORDER BY cs.sale_date DESC, cs.id DESC`,
    )
    .bind(customerId)
    .all();

  const sales: CreditSaleDto[] = salesResult.results.map((row: any) => ({
    id: row.id,
    customerId: row.customer_id,
    guarantorId: row.guarantor_id,
    guarantorName: row.guarantor_name,
    saleDate: row.sale_date,
    agreedMonths: row.agreed_months,
    installmentPeriodUnit: row.installment_period_unit,
    appliedMarkupValue: row.applied_markup_value,
    totalInstallmentPrice: row.total_installment_price,
    currencyCode: row.currency_code,
    manualExchangeRateMicros: row.manual_exchange_rate_micros,
    createdAt: row.created_at,
    items: [],
    installments: [],
  }));

  for (const sale of sales) {
    const itemsResult = await db
      .prepare(
        `SELECT ci.id, ci.sale_id, ci.product_id, p.name, ci.snapshot_cash_price, ci.quantity
         FROM credit_sale_item ci JOIN product p ON p.id = ci.product_id
         WHERE ci.sale_id = ?1
         ORDER BY ci.id`,
      )
      .bind(sale.id)
      .all();
    sale.items = itemsResult.results.map((row: any) => ({
      id: row.id,
      saleId: row.sale_id,
      productId: row.product_id,
      productName: row.name,
      snapshotCashPrice: row.snapshot_cash_price,
      quantity: row.quantity,
    }));

    const installmentsResult = await db
      .prepare(
        `SELECT i.id, i.sale_id, i.due_date, i.scheduled_amount, i.status,
                COALESCE((SELECT SUM(allocated_amount) FROM payment_allocation WHERE installment_id = i.id), 0) AS allocated
         FROM installment i
         WHERE i.sale_id = ?1
         ORDER BY i.due_date ASC, i.id ASC`,
      )
      .bind(sale.id)
      .all();
    sale.installments = installmentsResult.results.map((row: any) => ({
      id: row.id,
      saleId: row.sale_id,
      dueDate: row.due_date,
      scheduledAmount: row.scheduled_amount,
      allocatedAmount: row.allocated,
      remainingAmount: row.scheduled_amount - row.allocated,
      status: row.status,
    }));
  }

  return sales;
}
