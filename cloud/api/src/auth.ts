// Password hashing (PBKDF2) and session tokens (HS256 JWT), both built on
// Web Crypto -- available natively in the Workers runtime, so no external
// crypto dependency is needed for this.

// OWASP's current floor for PBKDF2-HMAC-SHA256 is 600k, but the Workers
// runtime's crypto.subtle hard-caps PBKDF2 at 100_000 iterations and
// throws for anything higher (found the hard way: this was 600_000 for
// one deploy and silently broke every hashPassword call -- new tenant
// creation and password resets both started failing with a 500, since
// nothing exercised that path in testing until a real reset attempt
// hit it). 100_000 is the actual ceiling here, not a deliberate choice.
const PBKDF2_ITERATIONS = 100_000;

/** Constant-time string equality -- avoids leaking how much of a hash
 * matched via early-exit timing on a plain `===` comparison. Lengths
 * aren't secret for a fixed-output hash, so an early return on mismatched
 * length is fine. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// Format: "<iterations>.<salt>.<hash>". The iteration count travels with
// the hash (not just this constant) so raising PBKDF2_ITERATIONS later
// only affects newly-hashed passwords -- existing hashes keep verifying
// against whatever count they were actually created with, the same way
// bcrypt embeds its cost factor. Old two-part hashes (from before this
// existed) are treated as 100_000, the original constant.
const LEGACY_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `${PBKDF2_ITERATIONS}.${toBase64Url(salt)}.${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(".");
  const [iterations, saltPart, hashPart] = parts.length === 3 ? parts : [String(LEGACY_ITERATIONS), parts[0], parts[1]];
  if (!saltPart || !hashPart) return false;
  const salt = fromBase64Url(saltPart);
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterations), hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return constantTimeEqual(toBase64Url(new Uint8Array(bits)), hashPart);
}

export interface SessionClaims {
  sub: string; // account id
  tenantId: string;
  role: "owner" | "staff";
  exp: number; // unix seconds
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return null;

  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionClaims;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
