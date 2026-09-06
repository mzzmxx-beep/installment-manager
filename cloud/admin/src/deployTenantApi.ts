// Adds/removes a tenant's D1 binding on the live installment-api Worker
// and redeploys it -- the piece that makes "add tenant" / "delete
// tenant" actually take effect on the servable app, not just the
// control plane. See cloud/README.md for why this has to be a real
// Worker binding (D1's HTTP management API can't provide the
// transaction atomicity money-critical writes need) rather than
// something installment-api could do purely at request time.
//
// TENANT_API_BUNDLE is installment-api's compiled output, embedded so
// this Worker can re-upload it unchanged (just with the binding list
// changed) without needing its own copy of the source. It MUST be
// regenerated whenever cloud/api's source changes -- see
// tenantApiBundle.ts's header.

import { TENANT_API_BUNDLE } from "./tenantApiBundle";

const SCRIPT_NAME = "installment-api";
const COMPATIBILITY_DATE = "2026-01-01";

interface WorkerBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

async function cf<T>(accountId: string, apiToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, ...init?.headers },
  });
  const rawText = await res.text();
  let body: { success: boolean; result: T; errors: { message: string }[] };
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Cloudflare API returned non-JSON (status ${res.status}): ${rawText.slice(0, 300)}`);
  }
  if (!res.ok || !body.success) {
    throw new Error(`Cloudflare API error (status ${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result;
}

async function getCurrentBindings(accountId: string, apiToken: string): Promise<WorkerBinding[]> {
  const settings = await cf<{ bindings: WorkerBinding[] }>(accountId, apiToken, `/workers/scripts/${SCRIPT_NAME}/settings`);
  return settings.bindings;
}

/**
 * Redeploys installment-api with the given binding list (unchanged
 * script content). `jwtSecret` must be installment-api's current
 * JWT_SECRET value -- Cloudflare's script-upload API is write-only for
 * secrets, so a redeploy that omits a secret_text binding's value fails
 * outright rather than silently keeping the old one. This Worker
 * therefore keeps its own copy as TENANT_API_JWT_SECRET, kept in sync by
 * hand whenever installment-api's JWT_SECRET is rotated (see
 * cloud/README.md).
 */
async function redeployWithBindings(accountId: string, apiToken: string, bindings: WorkerBinding[], jwtSecret: string): Promise<void> {
  const bindingsWithSecretValues = bindings.map((b) => (b.type === "secret_text" ? { ...b, text: jwtSecret } : b));

  const metadata = {
    main_module: "index.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: bindingsWithSecretValues,
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("index.js", new Blob([TENANT_API_BUNDLE], { type: "application/javascript+module" }), "index.js");

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: form,
  });
  const rawText = await res.text();
  let body: { success: boolean; errors: { message: string }[] };
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Redeploy returned non-JSON (status ${res.status}): ${rawText.slice(0, 500)}`);
  }
  if (!res.ok || !body.success) {
    throw new Error(`Redeploy failed (status ${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
}

/** Adds a D1 binding for the given tenant database and redeploys -- existing bindings are preserved as-is. */
export async function addTenantBindingAndRedeploy(
  accountId: string,
  apiToken: string,
  bindingName: string,
  tenantDatabaseId: string,
  jwtSecret: string,
): Promise<void> {
  const currentBindings = await getCurrentBindings(accountId, apiToken);
  if (currentBindings.some((b) => b.name === bindingName)) {
    throw new Error(`binding "${bindingName}" already exists on ${SCRIPT_NAME}`);
  }
  const bindings = [...currentBindings, { type: "d1", name: bindingName, id: tenantDatabaseId }];
  await redeployWithBindings(accountId, apiToken, bindings, jwtSecret);
}

/**
 * Removes a tenant's D1 binding and redeploys -- the first step of
 * deleting a tenant (cuts installment-api's access to their database
 * immediately, before the control-plane records or the database itself
 * are touched). A no-op (not an error) if the binding is already gone,
 * so delete-tenant stays safe to retry.
 */
export async function removeTenantBindingAndRedeploy(
  accountId: string,
  apiToken: string,
  bindingName: string,
  jwtSecret: string,
): Promise<void> {
  const currentBindings = await getCurrentBindings(accountId, apiToken);
  if (!currentBindings.some((b) => b.name === bindingName)) return;
  const bindings = currentBindings.filter((b) => b.name !== bindingName);
  await redeployWithBindings(accountId, apiToken, bindings, jwtSecret);
}
