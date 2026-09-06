// Thin wrapper around the Cloudflare D1 management HTTP API -- the part
// of D1 that a Worker binding can't reach (creating a new database,
// running arbitrary DDL against an arbitrary database id at runtime).
// Needs an Account-scoped API Token with D1 Edit permission, stored as
// this Worker's CF_API_TOKEN secret (see cloud/README.md).

const API_BASE = "https://api.cloudflare.com/client/v4";

async function cfFetch(accountId: string, apiToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}/accounts/${accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", ...init?.headers },
  });
  const rawText = await res.text();
  let body: { success: boolean; result: any; errors: { message: string }[] };
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

export async function createD1Database(accountId: string, apiToken: string, name: string): Promise<{ uuid: string; name: string }> {
  return cfFetch(accountId, apiToken, "/d1/database", { method: "POST", body: JSON.stringify({ name }) });
}

export async function runD1Query(accountId: string, apiToken: string, databaseId: string, sql: string): Promise<void> {
  await cfFetch(accountId, apiToken, `/d1/database/${databaseId}/query`, { method: "POST", body: JSON.stringify({ sql }) });
}

export async function deleteD1Database(accountId: string, apiToken: string, databaseId: string): Promise<void> {
  await cfFetch(accountId, apiToken, `/d1/database/${databaseId}`, { method: "DELETE" });
}
