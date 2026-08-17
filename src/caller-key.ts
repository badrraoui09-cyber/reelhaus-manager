// Turns a caller's IP address into a pseudonymous, non-reversible key for
// rate limiting — the raw IP is never persisted. Keyed with a dedicated
// Worker secret (PUBLIC_RATE_LIMIT_PEPPER) so the resulting key cannot be
// correlated with the same IP's use elsewhere, and is never reused for the
// Turnstile secret's purpose.
export async function hashCallerKey(
  ip: string,
  pepper: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ip)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * CF-Connecting-IP is set by the Cloudflare edge itself and cannot be
 * spoofed by the caller (unlike X-Forwarded-For, which any client can set
 * to an arbitrary value) — this is the only header trusted as the source IP.
 */
export function callerIpFromRequest(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}
