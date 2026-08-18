const API_ROUTES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
}> = [
  { method: "GET", pathname: /^\/api\/auth\/diagnostic$/ },
  { method: "GET", pathname: /^\/api\/ai\/health$/ },
  { method: "GET", pathname: /^\/api\/audit\/scans\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/reelscan\/v1\/client-zero$/ },
  { method: "POST", pathname: /^\/api\/scan$/ },
  { method: "GET", pathname: /^\/api\/reports$/ },
  { method: "GET", pathname: /^\/api\/reports\/[^/]+$/ },
  { method: "GET", pathname: /^\/api\/sales$/ },
  { method: "GET", pathname: /^\/api\/businesses\/search$/ },
  {
    method: "GET",
    pathname: /^\/api\/businesses\/[^/]+\/workspace$/
  },
  { method: "GET", pathname: /^\/api\/reelscan\/export$/ },
  { method: "POST", pathname: /^\/api\/discovery\/queue$/ },
  { method: "POST", pathname: /^\/api\/discovery\/run$/ },
  {
    method: "POST",
    pathname: /^\/api\/discovery\/candidates\/[^/]+\/reelscan$/
  },
  {
    method: "POST",
    pathname: /^\/api\/discovery\/candidates\/[^/]+\/scan$/
  },
  {
    method: "POST",
    pathname: /^\/api\/discovery\/candidates\/[^/]+\/decision$/
  },
  { method: "PATCH", pathname: /^\/api\/leads\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/audit$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/qualify$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/draft$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/quality-review$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/events$/ },
  {
    method: "POST",
    pathname: /^\/api\/leads\/[^/]+\/do-not-contact$/
  },
  { method: "PATCH", pathname: /^\/api\/drafts\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/review$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/approve$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/reject$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/send$/ },
  { method: "POST", pathname: /^\/api\/assistant$/ },
  { method: "GET", pathname: /^\/api\/inbound-requests$/ },
  // Task #2.7: internal-only report preview — Access-protected like every
  // other route in this table (never added to PUBLIC_API_ROUTES below).
  { method: "GET", pathname: /^\/api\/inbound-requests\/[^/]+\/report$/ },
  // Task #2.11: internal-only sales decision view — same protection, a
  // separate route/shape from the customer report above on purpose.
  { method: "GET", pathname: /^\/api\/inbound-requests\/[^/]+\/sales-decision$/ },
  // Task #2.19: internal-only ReelFix verification-link creation and the
  // printable before/after proof report — same Access-protected dispatch
  // as every other /inbound-requests* route, never added to
  // PUBLIC_API_ROUTES below.
  {
    method: "POST",
    pathname: /^\/api\/inbound-requests\/[^/]+\/reelfix-verification$/
  },
  {
    method: "GET",
    pathname: /^\/api\/inbound-requests\/[^/]+\/reelfix-proof$/
  },
  { method: "GET", pathname: /^\/api\/inbound-retention\/status$/ }
];

// The exact one route/method pair allowed to bypass Cloudflare Access — a
// separate list from API_ROUTES on purpose, so the public exception can
// never accidentally expand by editing the private route table. Kept as an
// exact string match (not a broader regex) so /api/public/foo,
// /api/public/reelscan/extra, and /api/public/reelscan/admin all correctly
// stay private.
const PUBLIC_API_ROUTES: ReadonlyArray<{ method: string; pathname: string }> = [
  { method: "POST", pathname: "/api/public/reelscan" },
  { method: "OPTIONS", pathname: "/api/public/reelscan" }
];

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isKnownApiRoute(method: string, pathname: string): boolean {
  return API_ROUTES.some(
    (route) => route.method === method && route.pathname.test(pathname)
  );
}

export function isPublicApiRoute(method: string, pathname: string): boolean {
  return PUBLIC_API_ROUTES.some(
    (route) => route.method === method && route.pathname === pathname
  );
}

// Task #2.21 security audit (Section 8, CSRF/HTTP behavior): Access-
// protected routes carried no CSRF-specific defense of their own — no
// anti-CSRF token, no Origin check, no Content-Type enforcement, unlike
// the public intake route (body-limit.ts), which already requires exactly
// "application/json". A classic technique (an attacker's cross-site
// <form enctype="text/plain"> POST, crafted so its body still parses as
// JSON) relies on the target accepting a non-JSON content type; every
// state-changing private route already expects and parses a JSON body
// (or none), so requiring the real content type here costs nothing for
// any legitimate caller — the Manager dashboard's own fetch wrapper
// already always sends it when it sends a body (see app.tsx) — while
// closing that path off. This does not replace Cloudflare Access itself
// as the actual authentication boundary; it is one additional, cheap,
// isolated check. Lives here (not server.ts) so it can be unit tested —
// server.ts re-exports ReelHausManager from sales-agent.ts, which pulls
// in a `cloudflare:`-scheme module the plain Node/vitest ESM loader
// cannot resolve, the same reason isKnownApiRoute()/isPublicApiRoute()
// above already live in this file rather than in server.ts.
export const STATE_CHANGING_METHODS = new Set([
  "POST",
  "PATCH",
  "PUT",
  "DELETE"
]);

export function hasValidJsonContentType(request: Request): boolean {
  const contentType = (request.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return contentType === "application/json";
}

/** True when a state-changing request with a body must be rejected for lacking a valid JSON Content-Type. */
export function rejectsForContentType(request: Request): boolean {
  return (
    STATE_CHANGING_METHODS.has(request.method) &&
    Boolean(request.body) &&
    !hasValidJsonContentType(request)
  );
}
