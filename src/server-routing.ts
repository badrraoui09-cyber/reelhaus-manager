const API_ROUTES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
}> = [
  { method: "POST", pathname: /^\/api\/scan$/ },
  { method: "GET", pathname: /^\/api\/reports$/ },
  { method: "GET", pathname: /^\/api\/reports\/[^/]+$/ },
  { method: "GET", pathname: /^\/api\/sales$/ },
  { method: "POST", pathname: /^\/api\/discovery\/queue$/ },
  { method: "POST", pathname: /^\/api\/discovery\/run$/ },
  { method: "PATCH", pathname: /^\/api\/leads\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/draft$/ },
  { method: "POST", pathname: /^\/api\/leads\/[^/]+\/events$/ },
  {
    method: "POST",
    pathname: /^\/api\/leads\/[^/]+\/do-not-contact$/
  },
  { method: "PATCH", pathname: /^\/api\/drafts\/[^/]+$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/approve$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/reject$/ },
  { method: "POST", pathname: /^\/api\/drafts\/[^/]+\/send$/ }
];

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isKnownApiRoute(method: string, pathname: string): boolean {
  return API_ROUTES.some(
    (route) => route.method === method && route.pathname.test(pathname)
  );
}
