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
