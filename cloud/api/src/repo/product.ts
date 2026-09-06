import { auditInsertStatement, newId } from "../db";

export interface ProductDto {
  id: string;
  name: string;
  referenceCashPrice: number;
  currencyCode: string;
  isActive: boolean;
}

export interface CreateProductPayload {
  name: string;
  referenceCashPrice: number;
  currencyCode: string;
}

function rowToDto(row: Record<string, unknown>): ProductDto {
  return {
    id: row.id as string,
    name: row.name as string,
    referenceCashPrice: row.reference_cash_price as number,
    currencyCode: row.currency_code as string,
    isActive: (row.is_active as number) !== 0,
  };
}

export async function createProduct(db: D1Database, payload: CreateProductPayload): Promise<ProductDto> {
  const id = newId();
  await db
    .prepare("INSERT INTO product (id, name, reference_cash_price, currency_code) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, payload.name, payload.referenceCashPrice, payload.currencyCode)
    .run();

  const row = await db
    .prepare("SELECT id, name, reference_cash_price, currency_code, is_active FROM product WHERE id = ?1")
    .bind(id)
    .first();
  const dto = rowToDto(row as Record<string, unknown>);

  await auditInsertStatement(db, "product", id, dto).run();
  return dto;
}

export async function getActiveProducts(db: D1Database): Promise<ProductDto[]> {
  const result = await db
    .prepare("SELECT id, name, reference_cash_price, currency_code, is_active FROM product WHERE is_active = 1 ORDER BY name")
    .all();
  return result.results.map((r) => rowToDto(r as Record<string, unknown>));
}
