// Strict validation for the real public ReelScan intake request body,
// matching the actual reelhaus.de form fields (name, business, city,
// support need, email and/or WhatsApp, an optional link that may be a
// website/Instagram/Google Maps/absent, optional free-text context,
// explicit privacy acceptance, FR/AR language, and a Turnstile token).
//
// This replaces Task #4's placeholder {url, email?, turnstileToken}
// schema, which was never wired to any route — it was a conceptual
// stand-in, not the product contract.
//
// The server controls model/prompt/schema/evidence/scanId/score entirely.
// Unknown fields are rejected outright rather than ignored, so a caller
// cannot smuggle in e.g. "prompt", "model", "scoreOverride", or "scanId"
// and have it silently dropped versus silently trusted. No customer free
// text (issue, name, businessName, etc.) is ever inserted into the
// ReelScan AI prompt — see reelscan.ts, which only ever receives
// EvidenceRecords derived from the fetched target site, never request
// fields.
//
// JSON.parse() is used for parsing (never a hand-rolled object walk), so a
// `"__proto__"` key in the input becomes an ordinary *own* property named
// "__proto__" on the parsed object — per the JSON spec this does not touch
// the prototype chain. Combined with the explicit field allowlist below,
// there is no path from request JSON to prototype pollution here.

export const SUPPORT_NEEDS = [
  "unknown",
  "reelscan",
  "local_visibility",
  "reelbuild",
  "reelcare",
  "other"
] as const;
export type SupportNeed = (typeof SUPPORT_NEEDS)[number];

export const INTAKE_LANGUAGES = ["fr", "ar"] as const;
export type IntakeLanguage = (typeof INTAKE_LANGUAGES)[number];

export type PublicRequestValidationError =
  | "invalid_json"
  | "unknown_fields"
  | "missing_name"
  | "name_too_long"
  | "missing_business_name"
  | "business_name_too_long"
  | "missing_city"
  | "city_too_long"
  | "invalid_support_need"
  | "missing_contact_method"
  | "invalid_email"
  | "email_too_long"
  | "invalid_whatsapp"
  | "link_too_long"
  | "issue_too_long"
  | "privacy_not_accepted"
  | "invalid_language"
  | "missing_turnstile_token"
  | "turnstile_token_too_long";

export interface PublicReelScanRequest {
  name: string;
  businessName: string;
  city: string;
  supportNeed: SupportNeed;
  email?: string;
  whatsapp?: string;
  link?: string;
  issue?: string;
  privacyAccepted: true;
  language: IntakeLanguage;
  turnstileToken: string;
}

export type PublicRequestValidationResult =
  | { ok: true; value: PublicReelScanRequest }
  | { ok: false; reason: PublicRequestValidationError };

const MAX_NAME_LENGTH = 200;
const MAX_BUSINESS_NAME_LENGTH = 200;
const MAX_CITY_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 mailbox length limit
const MAX_LINK_LENGTH = 2048; // matches url-safety.ts's own cap
const MAX_ISSUE_LENGTH = 2000;
// Cloudflare's documented Turnstile token maximum. Task #4 used 4096 as a
// placeholder before this figure was confirmed against the real product.
const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
const MIN_WHATSAPP_DIGITS = 6;
const MAX_WHATSAPP_DIGITS = 15; // E.164 upper bound

const ALLOWED_FIELDS = new Set([
  "name",
  "businessName",
  "city",
  "supportNeed",
  "email",
  "whatsapp",
  "link",
  "issue",
  "privacyAccepted",
  "language",
  "turnstileToken"
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Conservative WhatsApp normalization: strips everything but digits and a
 * single leading "+", and validates a plausible overall digit count. Never
 * invents or assumes a country code — a number submitted without one is
 * left exactly as ambiguous as the customer typed it; that is a human
 * follow-up concern, not something to guess at silently.
 */
function normalizeWhatsapp(raw: string): string | null {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < MIN_WHATSAPP_DIGITS || digits.length > MAX_WHATSAPP_DIGITS)
    return null;
  return hasPlus ? `+${digits}` : digits;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parsePublicReelScanRequest(
  raw: unknown
): PublicRequestValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "invalid_json" };

  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => !ALLOWED_FIELDS.has(key)))
    return { ok: false, reason: "unknown_fields" };

  if (!isNonEmptyString(body.name)) return { ok: false, reason: "missing_name" };
  if (body.name.length > MAX_NAME_LENGTH)
    return { ok: false, reason: "name_too_long" };

  if (!isNonEmptyString(body.businessName))
    return { ok: false, reason: "missing_business_name" };
  if (body.businessName.length > MAX_BUSINESS_NAME_LENGTH)
    return { ok: false, reason: "business_name_too_long" };

  if (!isNonEmptyString(body.city)) return { ok: false, reason: "missing_city" };
  if (body.city.length > MAX_CITY_LENGTH)
    return { ok: false, reason: "city_too_long" };

  if (
    typeof body.supportNeed !== "string" ||
    !SUPPORT_NEEDS.includes(body.supportNeed as SupportNeed)
  )
    return { ok: false, reason: "invalid_support_need" };

  if (
    typeof body.language !== "string" ||
    !INTAKE_LANGUAGES.includes(body.language as IntakeLanguage)
  )
    return { ok: false, reason: "invalid_language" };

  if (body.privacyAccepted !== true)
    return { ok: false, reason: "privacy_not_accepted" };

  if (!isNonEmptyString(body.turnstileToken))
    return { ok: false, reason: "missing_turnstile_token" };
  if (body.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH)
    return { ok: false, reason: "turnstile_token_too_long" };

  let email: string | undefined;
  if (body.email !== undefined) {
    if (typeof body.email !== "string") return { ok: false, reason: "invalid_email" };
    const trimmed = body.email.trim();
    if (trimmed) {
      if (trimmed.length > MAX_EMAIL_LENGTH)
        return { ok: false, reason: "email_too_long" };
      if (!EMAIL_PATTERN.test(trimmed))
        return { ok: false, reason: "invalid_email" };
      email = trimmed;
    }
  }

  let whatsapp: string | undefined;
  if (body.whatsapp !== undefined) {
    if (typeof body.whatsapp !== "string")
      return { ok: false, reason: "invalid_whatsapp" };
    if (body.whatsapp.trim()) {
      const normalized = normalizeWhatsapp(body.whatsapp);
      if (!normalized) return { ok: false, reason: "invalid_whatsapp" };
      whatsapp = normalized;
    }
  }

  if (!email && !whatsapp) return { ok: false, reason: "missing_contact_method" };

  let link: string | undefined;
  if (body.link !== undefined) {
    if (typeof body.link !== "string") return { ok: false, reason: "link_too_long" };
    const trimmed = body.link.trim();
    if (trimmed.length > MAX_LINK_LENGTH)
      return { ok: false, reason: "link_too_long" };
    if (trimmed) link = trimmed;
  }

  let issue: string | undefined;
  if (body.issue !== undefined) {
    if (typeof body.issue !== "string")
      return { ok: false, reason: "issue_too_long" };
    if (body.issue.length > MAX_ISSUE_LENGTH)
      return { ok: false, reason: "issue_too_long" };
    if (body.issue.trim()) issue = body.issue.trim();
  }

  return {
    ok: true,
    value: {
      name: body.name.trim(),
      businessName: body.businessName.trim(),
      city: body.city.trim(),
      supportNeed: body.supportNeed as SupportNeed,
      email,
      whatsapp,
      link,
      issue,
      privacyAccepted: true,
      language: body.language as IntakeLanguage,
      turnstileToken: body.turnstileToken
    }
  };
}

/**
 * Parses a raw request body string as JSON and validates it in one step,
 * for callers that haven't already parsed the body (e.g. the future public
 * route handler, after its own body-size check — see body-limit.ts).
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
