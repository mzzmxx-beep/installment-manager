import { Hono } from "hono";
import { hashPassword, signSession, verifyPassword, verifySession } from "./auth";
import { ApiError } from "./db";
import * as customerRepo from "./repo/customer";
import * as productRepo from "./repo/product";
import * as saleRepo from "./repo/sale";
import * as paymentRepo from "./repo/payment";
import * as reportingRepo from "./repo/reporting";
import * as analyticsRepo from "./repo/analytics";
import * as currencyReportRepo from "./repo/currencyReport";

type Bindings = {
  CONTROL_PLANE_DB: D1Database;
  // Phase 2 scope: exactly one tenant, statically bound. See wrangler.toml
  // and cloud/README.md for why this isn't dynamic yet.
  TENANT_DEMO_DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  tenantId: string;
  tenantDb: D1Database;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// -- Auth (control plane) ----------------------------------------------

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const account = await c.env.CONTROL_PLANE_DB.prepare(
    "SELECT id, tenant_id, password_hash, role FROM account WHERE email = ?1",
  )
    .bind(body.email)
    .first<{ id: string; tenant_id: string; password_hash: string; role: "owner" | "staff" }>();
  if (!account || !(await verifyPassword(body.password, account.password_hash))) {
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

  const tenant = await c.env.CONTROL_PLANE_DB.prepare("SELECT status, subscription_expires_at, d1_database_id FROM tenant WHERE id = ?1")
    .bind(claims.tenantId)
    .first<{ status: string; subscription_expires_at: string; d1_database_id: string }>();
  if (!tenant) throw new ApiError(403, "tenant not found");
  if (tenant.status === "suspended") throw new ApiError(403, "subscription suspended");
  if (new Date(tenant.subscription_expires_at) < new Date()) throw new ApiError(403, "subscription expired, please renew");

  // Only one tenant database is wired up in Phase 2 (see Bindings above).
  c.set("tenantId", claims.tenantId);
  c.set("tenantDb", c.env.TENANT_DEMO_DB);
  await next();
});

// -- Customers ------------------------------------------------------------

app.post("/api/customers", async (c) => {
  const payload = await c.req.json<customerRepo.CreateCustomerPayload>();
  const dto = await customerRepo.createCustomer(c.get("tenantDb"), payload);
  return c.json(dto, 201);
});

app.get("/api/customers", async (c) => {
  const search = c.req.query("search") ?? undefined;
  const dtos = await customerRepo.getCustomers(c.get("tenantDb"), search);
  return c.json(dtos);
});

// -- Products ---------------------------------------------------------------

app.post("/api/products", async (c) => {
  const payload = await c.req.json<productRepo.CreateProductPayload>();
  const dto = await productRepo.createProduct(c.get("tenantDb"), payload);
  return c.json(dto, 201);
});

app.get("/api/products", async (c) => {
  const dtos = await productRepo.getActiveProducts(c.get("tenantDb"));
  return c.json(dtos);
});

// -- Credit sales -----------------------------------------------------------

app.post("/api/sales", async (c) => {
  const payload = await c.req.json<saleRepo.CreateCreditSalePayload>();
  const dto = await saleRepo.createCreditSale(c.get("tenantDb"), payload);
  return c.json(dto, 201);
});

app.get("/api/customers/:customerId/sales", async (c) => {
  const dtos = await saleRepo.getSalesForCustomer(c.get("tenantDb"), c.req.param("customerId"));
  return c.json(dtos);
});

// -- Payments -----------------------------------------------------------

app.post("/api/payments", async (c) => {
  const payload = await c.req.json<paymentRepo.CreatePaymentPayload>();
  const dto = await paymentRepo.registerPayment(c.get("tenantDb"), payload);
  return c.json(dto, 201);
});

app.get("/api/customers/:customerId/payments", async (c) => {
  const dtos = await paymentRepo.getPaymentsForCustomer(c.get("tenantDb"), c.req.param("customerId"));
  return c.json(dtos);
});

// -- Reports & analytics -----------------------------------------------

app.get("/api/customers/:customerId/statement", async (c) => {
  const dto = await reportingRepo.getCustomerStatement(c.get("tenantDb"), c.req.param("customerId"));
  return c.json(dto);
});

app.get("/api/reports/overdue-installments", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const dtos = await reportingRepo.getOverdueInstallments(c.get("tenantDb"), date);
  return c.json(dtos);
});

app.get("/api/reports/sales-summary", async (c) => {
  const dtos = await analyticsRepo.getSalesSummary(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return c.json(dtos);
});

app.get("/api/reports/top-products", async (c) => {
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getTopProducts(c.get("tenantDb"), limit);
  return c.json(dtos);
});

app.get("/api/reports/top-customers", async (c) => {
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getTopCustomers(c.get("tenantDb"), limit);
  return c.json(dtos);
});

app.get("/api/reports/most-overdue-customers", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const limit = Number(c.req.query("limit") ?? "10");
  const dtos = await analyticsRepo.getMostOverdueCustomers(c.get("tenantDb"), date, limit);
  return c.json(dtos);
});

app.get("/api/reports/customers-overview", async (c) => {
  const dtos = await analyticsRepo.getCustomersOverview(c.get("tenantDb"));
  return c.json(dtos);
});

app.get("/api/reports/sale-conversions", async (c) => {
  const dtos = await currencyReportRepo.getSaleConversions(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return c.json(dtos);
});

app.get("/api/reports/payment-conversions", async (c) => {
  const dtos = await currencyReportRepo.getPaymentConversions(c.get("tenantDb"), c.req.query("from"), c.req.query("to"));
  return c.json(dtos);
});

app.get("/api/reports/product-conversion-summary", async (c) => {
  const dtos = await currencyReportRepo.getProductConversionSummary(c.get("tenantDb"));
  return c.json(dtos);
});

app.get("/api/reports/customer-conversion-summary", async (c) => {
  const dtos = await currencyReportRepo.getCustomerConversionSummary(c.get("tenantDb"));
  return c.json(dtos);
});

export default app;

// Exported for a one-off admin/setup script to hash a password when
// creating a control-plane account by hand (Phase 4 will replace this
// with the automated provisioning flow).
export { hashPassword };
