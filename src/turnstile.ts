// Server-side Cloudflare Turnstile verification for a future public
// ReelScan intake. Client-side widget success is never trusted alone — the
// token is always re-verified against Cloudflare's siteverify endpoint here.
// Fails closed: any missing input, network error, timeout, non-2xx
// response, or malformed payload resolves to success:false, never throws.
//
// Turnstile itself (the widget + siteverify API) is free on all Cloudflare
// plans, including Free — no paid feature is required for this design.

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes: string[];
}

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;

interface TurnstileApiResponse {
  success?: boolean;
  ["error-codes"]?: string[];
}

/**
 * A single-use, time-boxed check — a given token can only ever verify
 * successfully once (Cloudflare invalidates it after the first successful
 * siteverify call), so replaying a captured token does not pass again. The
 * caller is still responsible for pairing this with a rate limit, since an
 * attacker can solve many distinct challenges given enough time/automation.
 */
export async function verifyTurnstileToken(
  fetcher: typeof fetch,
  secretKey: string | undefined,
  token: string | undefined,
  remoteIp?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<TurnstileVerifyResult> {
  if (!secretKey) return { success: false, errorCodes: ["missing-secret-key"] };
  if (!token || !token.trim())
    return { success: false, errorCodes: ["missing-input-response"] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const response = await fetcher(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal
    });
    if (!response.ok)
      return { success: false, errorCodes: [`http_${response.status}`] };
    const payload = (await response.json()) as TurnstileApiResponse;
    return {
      success: payload.success === true,
      errorCodes: payload["error-codes"] || []
    };
  } catch (error) {
    return {
      success: false,
      errorCodes: [error instanceof Error ? error.message : "verify_failed"]
    };
  } finally {
    clearTimeout(timeout);
  }
}
