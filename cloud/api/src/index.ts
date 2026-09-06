import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { hashPassword, signSession, verifyPassword, verifySession } from "./auth";
import { ApiError } from "./db";
import { toCamelCase, toSnakeCase } from "./case";
import { checkLoginRateLimit, recordFailedLogin } from "./rateLimit";
import * as customerRepo from "./repo/customer";
import * as productRepo from "./repo/product";
import * as saleRepo from "./repo/sale";
import * as paymentRepo from "./repo/payment";
import * as reportingRepo from "./repo/reporting";
import * as analyticsRepo from "./repo/analytics";
import * as currencyReportRepo from "./repo/currencyReport";

type Bindings = {
  CONTROL_PLANE_DB: D1Database;
  JWT_SECRET: string;
  // Every other binding is one tenant's D1 database, added dynamically by
  // cloud/admin's provisioning flow (binding name = tenant.binding_name
  // in the control plane) -- there's no fixed set known at compile time.
  [bindingName: string]: unknown;
};

type Variables = {
  tenantId: string;
  tenantDb: D1Database;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// A wildcard origin would have been safe too (auth is a Bearer token the
// browser never attaches automatically, unlike cookies -- no CSRF
// exposure), but now that the real customer domain is live, there's no
// reason not to scope it down to just the frontends that actually need it.
const ALLOWED_ORIGINS = ["https://inst.iqcrl.com", "https://installment-web.pages.dev"];
app.use(
  "*",
  cors({ origin: ALLOWED_ORIGINS, allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "OPTIONS"] }),
);

// The existing React frontend (installment-manager/src) was written
// against the original Rust/serde wire format (snake_case field names).
// This Worker's internal code uses idiomatic camelCase -- these two
// helpers translate at the HTTP boundary so the frontend's data layer
// carries over unmodified (see case.ts).
async function readBody<T>(c: AppContext): Promise<T> {
  return toCamelCase(await c.req.json()) as T;
}
function json(c: AppContext, data: unknown, status?: number) {
  return c.json(toSnakeCase(data) as any, status as any);
}

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// -- Auth (control plane) ----------------------------------------------

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  await checkLoginRateLimit(c.env.CONTROL_PLANE_DB, body.email, "tenant");

  const account = await c.env.CONTROL_PLANE_DB.prepare(
    "SELECT id, tenant_id, password_hash, role FROM account WHERE email = ?1",
  )
    .bind(body.email)
    .first<{ id: string; tenant_id: string; password_hash: string; role: "owner" | "staff" }>();
  if (!account || !(await verifyPassword(body.password, account.password_hash))) {
    await recordFailedLogin(c.env.CONTROL_PLANE_DB, body.email, "tenant");
    throw new ApiError(401, "invalid email or password");
  }

  const tenant = await c.env.CONTROL_PLANE_DB.prepare("SELECT status, subscription_expires_at FROM tenant WHERE id = ?1")
    .bind(account.tenant_id)
    .first<{ status: string; subscription_expires_at: string }>();
  if (!tenant) throw new ApiError(403, "tenant not found");
  if (tenant.status === "suspended") throw new ApiError(403, "subscription suspended");
  if (new Date(tenant.subscription_expires_at) < new Date()) throw new ApiError(403, "subscription expired");

  const token = await signSession(
    { sub: account.id, tenantId: account.tenant_id, role: account.role, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    c.env.JWT_SECRET,
  );
  return c.json({ token });
});

// -- Tenant-scoped middleware --------------------------------------------
// Resolves the caller's session, re-checks subscription status on every
// request (not just at login -- an expired subscription must lock out an
// already-issued token), and attaches the right D1 database.

app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new ApiError(401, "missing bearer token");

  const claims = await verifySession(token, c.env.JWT_SECRET);
  if (!claims) throw new ApiError(401, "invalid or expired session");

  const tenant = await c.env.CONTROL_PLANE_DB.prepare("SELECT status, subscription_expires_at, binding_name FROM tenant WHERE id = ?1")
    .bind(claims.tenantId)
    .first<{ status: string; subscription_expires_at: string; binding_name: string | null }>();
  if (!tenant) throw new ApiError(403, "tenant not found");
  if (tenant.status === "suspended") throw new ApiError(403, "subscription suspended");
  if (new Date(tenant.subscription_expires_at) < new Date()) throw new ApiError(403, "subscription expired, please renew");
  if (!tenant.binding_name) throw new ApiError(503, "tenant provisioning incomplete -- no database bound yet");

  // Each tenant gets its own real D1 binding (added dynamically by
  // cloud/admin's provisioning flow) rather than a shared/HTTP-routed
  // database -- D1's HTTP management API has no multi-statement
  // transaction support, so it can't safely serve writes like
  // create_credit_sale that must be atomic. See cloud/README.md.
  const tenantDb = c.env[tenant.binding_name] as D1Database | undefined;
  if (!tenantDb) throw new ApiError(503, `tenant database binding "${tenant.binding_name}" not found on this Worker`);

  c.set("tenantId", claims.tenantId);
  c.set("tenantDb", tenantDb);
  await next();
});

// -- Customers ------------------------------------------------------------

app.post("/api/customers", async (c) => {
  const payload = await readBody<customerRepo.CreateCustomerPayload>(c);
  const dto = await customerRepo.createCustomer(c.get("tenantDb"), payload);
  return json(c, dto, 201);
});

app.get("/api/customers", async (c) => {
  const search = c.req.query("search") ?? undefined;
  const dtos = await customerRepo.getCustomers(c.get("tenantDb"), search);
  return json(c, dtos);
});

// -- Products ---------------------------------------------------------------

app.post("/api/products", async (c) => {
  const payload = await readBody<productRepo.CreateProductPayload>(c);
  const dto = await productRepo.createProduct(c.get("tenantDb"), payload);
  return json(c, dto, 201);
});

app.get("/api/products", async (c) => {
  const dtos = await productRepo.getActiveProducts(c.get("tenantDb"));
  return json(c, dtos);
});

// -- Credit sales -----------------------------------------------------------

app.post("/api/sales", async (c) => {
  const payload = await readBody<saleRepo.CreateCreditSalePayload>(c);
  const dto = await saleRepo.createCreditSale(c.get("tenantDb"), payload);
  return json(c, dto, 201);
});

app.get("/api/customers/:customerId/sales", async (c) => {
  const dtos = await saleRepo.getSalesForCustomer(c.get("tenantDb"), c.req.param("customerId"));
  return json(c, dtos);
});

// -- Payments -----------------------------------------------------------

app.post("/api/payments", async (c) => {
  const payload = await readBody<paymentRepo.CreatePaymentPayload>(c);
  const dto = await paymentRepo.registerPayment(c.get("tenantDb"), payload);
  return json(c, dto, 201);
});

app.get("/api/customers/:customerId/payments", async (c) => {
  const dtos = await paymentRepo.getPaymentsForCustomer(c.get("tenantDb"), c.req.param("customerId"));
  return json(c, dtos);
});

// -- Reports & analytics -----------------------------------------------

app.get("/api/customers/:customerId/statement", async (c) => {
  const dto = await reportingRepo.getCustomerStatement(c.get("tenantDb"), c.req.param("customerId"));
  return json(c, dto);
});

app.get("/api/reports/overdue-installments", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const dtos = await reportingRepo.getOverdueInstallments(c.get("tenantDb"), date);
  return json(c, dtos);
});

app.get("/api/reports/sales-summary", async (c) => {
  const dtos = await analyticsRepo.getSalesSummary(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return json(c, dtos);
});

app.get("/api/reports/top-products", async (c) => {
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getTopProducts(c.get("tenantDb"), limit);
  return json(c, dtos);
});

app.get("/api/reports/top-customers", async (c) => {
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getTopCustomers(c.get("tenantDb"), limit);
  return json(c, dtos);
});

app.get("/api/reports/most-overdue-customers", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getMostOverdueCustomers(c.get("tenantDb"), date, limit);
  return json(c, dtos);
});

app.get("/api/reports/customers-overview", async (c) => {
  const dtos = await analyticsRepo.getCustomersOverview(c.get("tenantDb"));
  return json(c, dtos);
});

app.get("/api/reports/sale-conversions", async (c) => {
  const dtos = await currencyReportRepo.getSaleConversions(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return json(c, dtos);
});

app.get("/api/reports/payment-conversions", async (c) => {
  const dtos = await currencyReportRepo.getPaymentConversions(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return json(c, dtos);
});

app.get("/api/reports/product-conversion-summary", async (c) => {
  const dtos = await currencyReportRepo.getProductConversionSummary(c.get("tenantDb"));
  return json(c, dtos);
});

app.get("/api/reports/customer-conversion-summary", async (c) => {
  const dtos = await currencyReportRepo.getCustomerConversionSummary(c.get("tenantDb"));
  return json(c, dtos);
});

export default app;

// Exported for a one-off admin/setup script to hash a password when
// creating a control-plane account by hand (Phase 4 will replace this
// with the automated provisioning flow).
export { hashPassword };
