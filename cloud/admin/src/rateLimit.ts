// Brute-force protection for login endpoints, backed by the control
// plane's login_attempt table (shared with installment-admin-api, which
// has its own identical copy of this file -- see cloud/README.md).

import { ApiError } from "./db";

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const PRUNE_AFTER_HOURS = 24;

/** Throws 429 if this email has hit the failed-attempt limit within the window. Call before verifying the password. */
export async function checkLoginRateLimit(db: D1Database, email: string, scope: "tenant" | "admin"): Promise<void> {
  // Opportunistic cleanup -- keeps the table from growing unbounded
  // without needing a separate cron job.
  const pruneCutoff = new Date(Date.now() - PRUNE_AFTER_HOURS * 60 * 60_000).toISOString();
  await db.prepare("DELETE FROM login_attempt WHERE attempted_at < ?1").bind(pruneCutoff).run();

  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM login_attempt WHERE email = ?1 AND scope = ?2 AND attempted_at > ?3")
    .bind(email, scope, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= MAX_ATTEMPTS) {
    throw new ApiError(429, "محاولات دخول كثيرة جداً، حاول مرة أخرى بعد بضع دقائق");
  }
}

export async function recordFailedLogin(db: D1Database, email: string, scope: "tenant" | "admin"): Promise<void> {
  await db.prepare("INSERT INTO login_attempt (email, scope) VALUES (?1, ?2)").bind(email, scope).run();
}
