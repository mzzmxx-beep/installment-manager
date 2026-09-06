import { auditInsertStatement, newId } from "../db";

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  nationalId: string;
  address: string | null;
  createdAt: string;
}

export interface CreateCustomerPayload {
  name: string;
  phone?: string | null;
  nationalId: string;
  address?: string | null;
}

function rowToDto(row: Record<string, unknown>): CustomerDto {
  return {
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? null,
    nationalId: row.national_id as string,
    address: (row.address as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function createCustomer(db: D1Database, payload: CreateCustomerPayload): Promise<CustomerDto> {
  const id = newId();
  await db
    .prepare("INSERT INTO customer (id, name, phone, national_id, address) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, payload.name, payload.phone ?? null, payload.nationalId, payload.address ?? null)
    .run();

  const row = await db
    .prepare("SELECT id, name, phone, national_id, address, created_at FROM customer WHERE id = ?1")
    .bind(id)
    .first();
  const dto = rowToDto(row as Record<string, unknown>);

  await auditInsertStatement(db, "customer", id, dto).run();
  return dto;
}

export async function getCustomers(db: D1Database, searchTerm?: string): Promise<CustomerDto[]> {
  const result = await db
    .prepare(
      `SELECT id, name, phone, national_id, address, created_at
       FROM customer
       WHERE ?1 IS NULL OR name LIKE '%' || ?1 || '%' OR national_id LIKE '%' || ?1 || '%'
       ORDER BY name`,
    )
    .bind(searchTerm ?? null)
    .all();
  return result.results.map((r) => rowToDto(r as Record<string, unknown>));
}
