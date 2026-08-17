// Strict validation for the future public ReelScan intake request body.
// The server controls model/prompt/schema/evidence entirely — the public
// caller can only ever submit a target URL, an optional email, and a
// Turnstile token. Nothing else is accepted, by construction: unknown
// fields are rejected rather than ignored, so a caller cannot smuggle in
// e.g. a "prompt", "model", "evidence", or "scoreOverride" field and have
// it silently dropped versus silently trusted.
//
// JSON.parse() is used for parsing (never a hand-rolled object walk), so a
// `"__proto__"` key in the input becomes an ordinary *own* property named
// "__proto__" on the parsed object — per the JSON spec this does not touch
// the prototype chain. Combined with the explicit field allowlist below,
// there is no path from request JSON to prototype pollution here.

export type PublicRequestValidationError =
  | "invalid_json"
  | "unknown_fields"
  | "missing_url"
  | "url_too_long"
  | "invalid_email"
  | "email_too_long"
  | "missing_turnstile_token"
  | "turnstile_token_too_long";

export interface PublicReelScanRequest {
  url: string;
  email?: string;
  turnstileToken: string;
}

export type PublicRequestValidationResult =
  | { ok: true; value: PublicReelScanRequest }
  | { ok: false; reason: PublicRequestValidationError };

const MAX_URL_LENGTH = 2048;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 mailbox length limit
const MAX_TURNSTILE_TOKEN_LENGTH = 4096; // generous; real tokens are far shorter
const ALLOWED_FIELDS = new Set(["url", "email", "turnstileToken"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parsePublicReelScanRequest(
  raw: unknown
): PublicRequestValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "invalid_json" };

  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => !ALLOWED_FIELDS.has(key)))
    return { ok: false, reason: "unknown_fields" };

  if (typeof body.url !== "string" || !body.url.trim())
    return { ok: false, reason: "missing_url" };
  if (body.url.length > MAX_URL_LENGTH) return { ok: false, reason: "url_too_long" };

  if (typeof body.turnstileToken !== "string" || !body.turnstileToken.trim())
    return { ok: false, reason: "missing_turnstile_token" };
  if (body.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH)
    return { ok: false, reason: "turnstile_token_too_long" };

  let email: string | undefined;
  if (body.email !== undefined) {
    if (typeof body.email !== "string") return { ok: false, reason: "invalid_email" };
    const trimmed = body.email.trim();
    if (trimmed.length > MAX_EMAIL_LENGTH)
      return { ok: false, reason: "email_too_long" };
    if (!EMAIL_PATTERN.test(trimmed))
      return { ok: false, reason: "invalid_email" };
    email = trimmed;
  }

  return {
    ok: true,
    value: { url: body.url.trim(), email, turnstileToken: body.turnstileToken }
  };
}

/**
 * Parses a raw request body string as JSON and validates it in one step,
 * for callers that haven't already parsed the body (e.g. a future route
 * handler reading `await request.text()` after a size check).
 */
export function parsePublicReelScanRequestBody(
  rawBody: string
): PublicRequestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  return parsePublicReelScanRequest(parsed);
}
