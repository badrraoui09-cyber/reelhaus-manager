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
  | "fetch_timeout"
  | `http_${number}`
  | "unsupported_content_type"
  | "content_too_large"
  | "empty_body";

export interface SafeFetchOptions {
  /**
   * Total wall-clock budget (ms) for the WHOLE operation: the initial
   * connection, every redirect hop, AND streaming the final response
   * body. Task #5A-fix round 4 §3 — a prior version cleared its timeout
   * once headers arrived, leaving a slow/stalled body unbounded; a single
   * deadline now covers every phase, not just "time to first byte."
   */
  totalTimeoutMs?: number;
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

const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_CONTENT_BYTES = 2_000_000;
const DEFAULT_ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const DEFAULT_USER_AGENT = "ReelHaus-Manager/1.0 public-reelscan-intake";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Distinguishes "our own deadline fired" from any other rejection, regardless of what the underlying fetch/stream throws for it. */
class FetchDeadlineExceeded extends Error {}

/**
 * Races `promise` against the shared wall-clock `deadline`, not a fresh
 * per-call duration — every hop and every body chunk draws down the SAME
 * total budget. Self-contained (does not depend on the underlying
 * fetch/stream honoring an AbortSignal), so it behaves identically for a
 * real Workers fetch() and for a test fake that ignores signals entirely.
 * Always clears its own timer, whichever side wins.
 */
function raceWithDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new FetchDeadlineExceeded());
      return;
    }
    const timer = setTimeout(() => reject(new FetchDeadlineExceeded()), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function safeFetchPublicUrl(
  fetcher: typeof fetch,
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult | SafeFetchError> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const allowedContentTypes =
    options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  let currentUrl = rawUrl;
  const visited = new Set<string>();

  // One deadline for the entire operation. The AbortController is wired
  // to it too — real resource cleanup (the Workers runtime tears down the
  // underlying connection/stream on abort) — but raceWithDeadline() is
  // the mechanism this function actually depends on for correctness,
  // since it works whether or not the fetcher honors the signal.
  const deadline = Date.now() + totalTimeoutMs;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), totalTimeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const validation = validatePublicScanUrl(currentUrl);
      if (!validation.ok)
        return { ok: false, reason: `unsafe_url:${validation.reason}` };
      if (visited.has(validation.url)) return { ok: false, reason: "redirect_loop" };
      visited.add(validation.url);

      let response: Response;
      try {
        response = await raceWithDeadline(
          fetcher(validation.url, {
            redirect: "manual",
            signal: controller.signal,
            headers: { "user-agent": userAgent, accept: "text/html" }
          }),
          deadline
        );
      } catch (error) {
        if (error instanceof FetchDeadlineExceeded || controller.signal.aborted)
          return { ok: false, reason: "fetch_timeout" };
        return {
          ok: false,
          reason: `fetch_failed:${error instanceof Error ? error.message : "unknown"}`
        };
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
      try {
        for (;;) {
          // Same shared deadline as the initial connection — a body that
          // stalls after headers arrive (a hostile or buggy server
          // returning fast headers and then never finishing the body) is
          // bounded exactly like a slow initial connection, not left to
          // run indefinitely just because the byte cap hasn't been hit.
          const { done, value } = await raceWithDeadline(reader.read(), deadline);
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
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof FetchDeadlineExceeded || controller.signal.aborted)
          return { ok: false, reason: "fetch_timeout" };
        return {
          ok: false,
          reason: `fetch_failed:${error instanceof Error ? error.message : "unknown"}`
        };
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
  } finally {
    clearTimeout(abortTimer);
  }
}
