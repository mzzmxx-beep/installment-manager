import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { hashPassword, verifyPassword, signSession, verifySession } from "./auth";
import { ApiError, newId } from "./db";
import { toCamelCase, toSnakeCase } from "./case";
import { createD1Database, deleteD1Database, runD1Query } from "./cloudflare";
import { addTenantBindingAndRedeploy } from "./deployTenantApi";
import { tenantSchemaStatements } from "./tenantSchema";
import { ADMIN_PANEL_HTML } from "./adminPanel";

type Bindings = {
  CONTROL_PLANE_DB: D1Database;
  ADMIN_JWT_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD_HASH: string;
  // Only needed for POST /admin/tenants (creating a new tenant database).
  // Everything else works without these -- see cloud/README.md for how
  // to obtain a token and cloud/admin/wrangler.toml for how it's wired.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // installment-api's current JWT_SECRET, kept in sync by hand -- see
  // deployTenantApi.ts's header for why this has to be duplicated here.
  TENANT_API_JWT_SECRET?: string;
};

type AppContext = Context<{ Bindings: Bindings }>;

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"], allowMethods: ["GET", "POST", "OPTIONS"] }));

async function readBody<T>(c: AppContext): Promise<T> {
  return toCamelCase(await c.req.json()) as T;
}
function json(c: AppContext, data: unknown, status?: number) {
  return c.json(toSnakeCase(data) as any, status as any);
}

app.get("/", (c) => c.html(ADMIN_PANEL_HTML));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  // Internal single-operator tool -- surfacing the real message to the
  // admin panel is useful, not a leak (no end customer ever sees this).
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});

// -- Admin auth -----------------------------------------------------------
// Single operator, no accounts table -- credentials are Worker secrets.

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  if (body.email !== c.env.ADMIN_EMAIL || !(await verifyPassword(body.password, c.env.ADMIN_PASSWORD_HASH))) {
    throw new ApiError(401, "invalid email or password");
  }
  const token = await signSession({ sub: "admin", role: "admin", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12 }, c.env.ADMIN_JWT_SECRET);
  return c.json({ token });
});

app.use("/admin/*", async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new ApiError(401, "missing bearer token");
  const claims = await verifySession(token, c.env.ADMIN_JWT_SECRET);
  if (!claims || claims.role !== "admin") throw new ApiError(401, "invalid or expired session");
  await next();
});

// -- Tenants ----------------------------------------------------------------

app.get("/admin/tenants", async (c) => {
  const result = await c.env.CONTROL_PLANE_DB.prepare(
    `SELECT t.id, t.shop_name, t.owner_name, t.phone, t.status, t.subscription_expires_at, t.created_at, a.email AS owner_email
     FROM tenant t
     LEFT JOIN account a ON a.tenant_id = t.id AND a.role = 'owner'
     ORDER BY t.created_at DESC`,
  ).all();
  return json(c, result.results);
});

app.get("/admin/tenants/:id", async (c) => {
  const tenant = await c.env.CONTROL_PLANE_DB.prepare(
    `SELECT t.*, a.email AS owner_email FROM tenant t LEFT JOIN account a ON a.tenant_id = t.id AND a.role = 'owner' WHERE t.id = ?1`,
  )
    .bind(c.req.param("id"))
    .first();
  if (!tenant) throw new ApiError(404, "tenant not found");

  const events = await c.env.CONTROL_PLANE_DB.prepare(
    "SELECT * FROM subscription_event WHERE tenant_id = ?1 ORDER BY created_at DESC",
  )
    .bind(c.req.param("id"))
    .all();

  return json(c, { ...tenant, events: events.results });
});

interface NewTenantPayload {
  shopName: string;
  ownerName: string;
  phone: string;
  email: string;
  password: string;
}

function slugify(value: string): string {
  // D1 database names must be simple identifiers -- transliterate/strip
  // anything else and fall back to a random suffix if nothing's left
  // (e.g. an all-Arabic shop name).
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "shop";
}

/**
 * Full self-service tenant provisioning: creates an isolated D1 database
 * for the new shop, applies the tenant schema to it, and registers the
 * shop + its owner account in the control plane -- the "add a customer
 * with no manual steps" goal from the SaaS transformation plan.
 *
 * Requires CF_API_TOKEN/CF_ACCOUNT_ID (see Bindings above) since creating
 * a D1 database and running DDL against an arbitrary database id is a
 * Cloudflare account-management operation, not something a static Worker
 * binding can do.
 */
app.post("/admin/tenants", async (c) => {
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    throw new ApiError(501, "التزويد التلقائي غير مفعّل بعد — يحتاج CF_API_TOKEN/CF_ACCOUNT_ID (راجع cloud/README.md)");
  }
  const payload = await readBody<NewTenantPayload>(c);
  if (!payload.shopName || !payload.ownerName || !payload.phone || !payload.email || !payload.password) {
    throw new ApiError(400, "كل الحقول مطلوبة");
  }

  const existing = await c.env.CONTROL_PLANE_DB.prepare("SELECT id FROM account WHERE email = ?1").bind(payload.email).first();
  if (existing) throw new ApiError(409, "البريد الإلكتروني مستخدم مسبقاً");

  const tenantId = newId();
  const dbName = `tenant-${slugify(payload.shopName)}-${tenantId.slice(0, 8)}`;

  if (!c.env.TENANT_API_JWT_SECRET) {
    throw new ApiError(501, "التزويد التلقائي غير مكتمل — TENANT_API_JWT_SECRET مفقود (راجع cloud/README.md)");
  }

  const database = await createD1Database(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, dbName);
  const bindingName = `TENANT_${tenantId.replace(/-/g, "").toUpperCase()}`;
  // From here on, any failure must delete the database we just created --
  // D1 databases on this account are a scarce, capped resource (see
  // cloud/README.md), and an orphaned one silently eats a slot that a
  // real tenant might need next.
  try {
    for (const statement of tenantSchemaStatements()) {
      await runD1Query(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, database.uuid, statement);
    }

    // Give installment-api a real binding to this tenant's database and
    // redeploy it -- an HTTP-routed connection can't provide the
    // transaction atomicity money-critical writes need (see
    // deployTenantApi.ts and cloud/README.md), so this tenant isn't
    // actually servable until this step succeeds.
    await addTenantBindingAndRedeploy(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, bindingName, database.uuid, c.env.TENANT_API_JWT_SECRET);
  } catch (err) {
    await deleteD1Database(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, database.uuid).catch(() => {});
    throw err;
  }

  const trialExpires = new Date();
  trialExpires.setDate(trialExpires.getDate() + 30);

  const accountId = newId();
  const passwordHash = await hashPassword(payload.password);

  await c.env.CONTROL_PLANE_DB.batch([
    c.env.CONTROL_PLANE_DB.prepare(
      "INSERT INTO tenant (id, shop_name, owner_name, phone, email, d1_database_id, binding_name, status, subscription_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'trial', ?8)",
    ).bind(tenantId, payload.shopName, payload.ownerName, payload.phone, payload.email, database.uuid, bindingName, trialExpires.toISOString()),
    c.env.CONTROL_PLANE_DB.prepare(
      "INSERT INTO account (id, tenant_id, email, password_hash, role) VALUES (?1, ?2, ?3, ?4, 'owner')",
    ).bind(accountId, tenantId, payload.email, passwordHash),
  ]);

  return json(c, { id: tenantId, dbName, subscriptionExpiresAt: trialExpires.toISOString() }, 201);
});

interface SubscriptionActionPayload {
  action: "activate" | "extend" | "suspend";
  newExpiresAt?: string;
  note?: string;
}

app.post("/admin/tenants/:id/subscription", async (c) => {
  const tenantId = c.req.param("id");
  const payload = await readBody<SubscriptionActionPayload>(c);

  const tenant = await c.env.CONTROL_PLANE_DB.prepare("SELECT id FROM tenant WHERE id = ?1").bind(tenantId).first();
  if (!tenant) throw new ApiError(404, "tenant not found");

  if (payload.action === "suspend") {
    await c.env.CONTROL_PLANE_DB.prepare("UPDATE tenant SET status = 'suspended' WHERE id = ?1").bind(tenantId).run();
  } else {
    if (!payload.newExpiresAt) throw new ApiError(400, "new_expires_at is required for activate/extend");
    await c.env.CONTROL_PLANE_DB.prepare("UPDATE tenant SET status = 'active', subscription_expires_at = ?1 WHERE id = ?2")
      .bind(payload.newExpiresAt, tenantId)
      .run();
  }

  await c.env.CONTROL_PLANE_DB.prepare(
    "INSERT INTO subscription_event (id, tenant_id, action, new_expires_at, note) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(newId(), tenantId, payload.action, payload.newExpiresAt ?? null, payload.note ?? null)
    .run();

  return json(c, { ok: true });
});

export default app;
