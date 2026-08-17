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
  hostname?: string;
  action?: string;
}

export interface TurnstileVerifyOptions {
  /** CF-Connecting-IP of the caller, passed through to siteverify for its own risk scoring. */
  remoteIp?: string;
  timeoutMs?: number;
  /**
   * Extra, non-authoritative checks: siteverify's `success` remains the
   * only thing that actually gates the request. A hostname/action mismatch
   * on an otherwise-successful verification still fails closed here, but
   * neither field is ever trusted in isolation of `success === true`.
   */
  expectedHostnames?: readonly string[];
  expectedAction?: string;
}

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;

interface TurnstileApiResponse {
  success?: boolean;
  ["error-codes"]?: string[];
  hostname?: string;
  action?: string;
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
  options: TurnstileVerifyOptions = {}
): Promise<TurnstileVerifyResult> {
  if (!secretKey) return { success: false, errorCodes: ["missing-secret-key"] };
  if (!token || !token.trim())
    return { success: false, errorCodes: ["missing-input-response"] };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (options.remoteIp) body.set("remoteip", options.remoteIp);
    const response = await fetcher(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal
    });
    if (!response.ok)
      return { success: false, errorCodes: [`http_${response.status}`] };
    const payload = (await response.json()) as TurnstileApiResponse;

    if (payload.success !== true)
      return {
        success: false,
        errorCodes: payload["error-codes"] || [],
        hostname: payload.hostname,
        action: payload.action
      };

    if (
      options.expectedHostnames?.length &&
      (!payload.hostname || !options.expectedHostnames.includes(payload.hostname))
    )
      return {
        success: false,
        errorCodes: ["hostname-mismatch"],
        hostname: payload.hostname,
        action: payload.action
      };

    if (options.expectedAction && payload.action !== options.expectedAction)
      return {
        success: false,
        errorCodes: ["action-mismatch"],
        hostname: payload.hostname,
        action: payload.action
      };

    return {
      success: true,
      errorCodes: [],
      hostname: payload.hostname,
      action: payload.action
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
