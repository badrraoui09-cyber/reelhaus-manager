// A redirect-safe, resource-bounded fetcher for a future public ReelScan
// intake. Every hop — the initial URL AND every redirect target — is
// re-validated through url-safety.ts before it is fetched; nothing here
// trusts the first check to still hold after a 3xx response.
import { validatePublicScanUrl } from "./url-safety";

export type SafeFetchRejectionReason =
  | `unsafe_url:${string}`
  | "redirect_loop"
  | "too_many_redirects"
  | "redirect_missing_location"
  | `fetch_failed:${string}`
  | `http_${number}`
  | "unsupported_content_type"
  | "content_too_large"
  | "empty_body";

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxContentBytes?: number;
  allowedContentTypes?: readonly string[];
  userAgent?: string;
}

export interface SafeFetchResult {
  ok: true;
  html: string;
  finalUrl: string;
  redirectCount: number;
}

export interface SafeFetchError {
  ok: false;
  reason: SafeFetchRejectionReason;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_CONTENT_BYTES = 2_000_000;
const DEFAULT_ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const DEFAULT_USER_AGENT = "ReelHaus-Manager/1.0 public-reelscan-intake";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetchPublicUrl(
  fetcher: typeof fetch,
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult | SafeFetchError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const allowedContentTypes =
    options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  let currentUrl = rawUrl;
  const visited = new Set<string>();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validation = validatePublicScanUrl(currentUrl);
    if (!validation.ok)
      return { ok: false, reason: `unsafe_url:${validation.reason}` };
    if (visited.has(validation.url)) return { ok: false, reason: "redirect_loop" };
    visited.add(validation.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(validation.url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": userAgent, accept: "text/html" }
      });
    } catch (error) {
      return {
        ok: false,
        reason: `fetch_failed:${error instanceof Error ? error.message : "unknown"}`
      };
    } finally {
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "redirect_missing_location" };
      if (hop === maxRedirects) return { ok: false, reason: "too_many_redirects" };
      try {
        currentUrl = new URL(location, validation.url).toString();
      } catch {
        return { ok: false, reason: "unsafe_url:malformed_url" };
      }
      continue;
    }

    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!allowedContentTypes.includes(contentType))
      return { ok: false, reason: "unsupported_content_type" };

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxContentBytes)
      return { ok: false, reason: "content_too_large" };

    if (!response.body) return { ok: false, reason: "empty_body" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Enforced against the actual bytes read, not just the (possibly
      // absent or lied-about) content-length header.
      if (total > maxContentBytes) {
        await reader.cancel();
        return { ok: false, reason: "content_too_large" };
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();

    return {
      ok: true,
      html,
      finalUrl: validation.url,
      redirectCount: hop
    };
  }

  return { ok: false, reason: "too_many_redirects" };
}
