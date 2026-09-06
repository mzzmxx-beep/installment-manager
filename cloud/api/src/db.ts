// Small shared helpers for talking to a tenant D1 database.

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, (frac) => frac); // keep millis, matches strftime('%Y-%m-%dT%H:%M:%fZ')
}

/** Mirrors audit.rs::log_insert -- every mutating action gets one row here. */
export function auditInsertStatement(db: D1Database, tableName: string, recordId: string, payload: unknown): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (id, table_name, record_id, action, new_payload) VALUES (?1, ?2, ?3, 'INSERT', ?4)")
    .bind(newId(), tableName, recordId, JSON.stringify(payload));
}

/** Mirrors audit.rs::log_update. */
export function auditUpdateStatement(
  db: D1Database,
  tableName: string,
  recordId: string,
  oldPayload: unknown,
  newPayload: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_log (id, table_name, record_id, action, old_payload, new_payload) VALUES (?1, ?2, ?3, 'UPDATE', ?4, ?5)",
    )
    .bind(newId(), tableName, recordId, JSON.stringify(oldPayload), JSON.stringify(newPayload));
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
