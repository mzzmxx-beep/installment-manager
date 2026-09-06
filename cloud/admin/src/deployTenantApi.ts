// Adds a new tenant's D1 binding to the live installment-api Worker and
// redeploys it -- the piece that makes "add tenant" actually servable,
// not just provisioned. See cloud/README.md for why this has to be a
// real Worker binding (D1's HTTP management API can't provide the
// transaction atomicity money-critical writes need) rather than
// something installment-api could do purely at request time.
//
// TENANT_API_BUNDLE is installment-api's compiled output, embedded so
// this Worker can re-upload it unchanged (just with one more binding)
// without needing its own copy of the source. It MUST be regenerated
// whenever cloud/api's source changes -- see tenantApiBundle.ts's header.

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
 * Adds a D1 binding for the given tenant database to installment-api
 * and pushes a new deployment -- existing bindings (including secret
 * values, which are never included/changed here) are preserved as-is.
 *
 * `jwtSecret` must be installment-api's current JWT_SECRET value.
 * Cloudflare's script-upload API is write-only for secrets -- it never
 * returns them, so a redeploy that omits a secret_text binding's value
 * fails outright rather than silently keeping the old one. This Worker
 * therefore keeps its own copy as TENANT_API_JWT_SECRET, kept in sync by
 * hand whenever installment-api's JWT_SECRET is rotated (see
 * cloud/README.md).
 */
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

  const bindingsWithSecretValues = currentBindings.map((b) =>
    b.type === "secret_text" ? { ...b, text: jwtSecret } : b,
  );
  const bindings: WorkerBinding[] = [...bindingsWithSecretValues, { type: "d1", name: bindingName, id: tenantDatabaseId }];

  const metadata = {
    main_module: "index.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings,
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
