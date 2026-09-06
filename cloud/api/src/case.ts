// The existing React frontend (installment-manager/src) was written
// against the original Rust/serde wire format, which keeps Rust's
// snake_case struct field names as-is in JSON. This Worker's internal
// TypeScript code uses idiomatic camelCase instead -- these two
// converters translate at the HTTP boundary so the frontend can be
// reused with its data layer untouched.

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function deepConvert(value: unknown, convertKey: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => deepConvert(v, convertKey));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[convertKey(k)] = deepConvert(v, convertKey);
    }
    return result;
  }
  return value;
}

export function toSnakeCase<T>(value: T): unknown {
  return deepConvert(value, camelToSnake);
}

export function toCamelCase<T>(value: T): unknown {
  return deepConvert(value, snakeToCamel);
}
