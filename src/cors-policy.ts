// Narrow CORS policy for a future public ReelScan intake endpoint only.
// The Manager/dashboard and every existing /api/* route stay behind
// Cloudflare Access with no CORS headers at all — Access-protected routes
// are same-origin/Access-session based, not meant to be called
// cross-origin from arbitrary browser pages, so nothing here touches them.
//
// CORS is a browser-enforced *response* policy, not authentication: it
// only controls which origins a browser will let read the response. It
// does nothing to stop a non-browser client (curl, a server, a script)
// from calling the endpoint directly. Turnstile + rate limiting (see
// turnstile.ts, rate-limit.ts) are the actual access controls; this module
// only decides which headers a real browser request gets back.

import { PUBLIC_CORS_ORIGINS } from "./public-intake-config";

const ALLOWED_PUBLIC_ORIGINS = new Set<string>(PUBLIC_CORS_ORIGINS);

export interface CorsDecision {
  allowed: boolean;
  headers: Record<string, string>;
}

/**
 * Never sets Access-Control-Allow-Credentials, and never echoes back an
 * unrecognized origin — an unlisted origin gets no CORS headers at all
 * (the browser then blocks the response from being read), not a
 * fallback/wildcard origin.
 */
export function evaluatePublicCors(origin: string | null): CorsDecision {
  if (!origin || !ALLOWED_PUBLIC_ORIGINS.has(origin))
    return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "origin"
    }
  };
}

/** Explicit preflight (OPTIONS) response headers for the public endpoint. */
export function publicCorsPreflightHeaders(
  origin: string | null
): Record<string, string> {
  return evaluatePublicCors(origin).headers;
}
