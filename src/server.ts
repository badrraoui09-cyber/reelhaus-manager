export { ReelHausManager } from "./sales-agent";
import {
  accessDiagnostic,
  validateCloudflareAccess,
  type AccessValidationResult
} from "./access-auth";
import { isApiPath, isKnownApiRoute } from "./server-routing";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

type WorkerEnv = Env & {
  GUARDIAN_API_TOKEN?: string;
  ALLOW_LOCAL_BEARER_AUTH?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

type AuthResult =
  | { identity: string; access: AccessValidationResult }
  | { identity?: never; access: AccessValidationResult };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

async function authenticate(
  request: Request,
  env: WorkerEnv
): Promise<AuthResult> {
  const access = await validateCloudflareAccess(request, env);
  if (access.status === "authenticated")
    return { identity: access.identity, access };
  if (
    String(env.ALLOW_LOCAL_BEARER_AUTH) === "true" &&
    env.GUARDIAN_API_TOKEN &&
    request.headers.get("authorization") === `Bearer ${env.GUARDIAN_API_TOKEN}`
  )
    return { identity: "local-token-user", access };
  return { access };
}

function authenticationError(access: AccessValidationResult): {
  code: string;
  error: string;
} {
  if (access.status === "not_configured")
    return {
      code: "ACCESS_NOT_CONFIGURED",
      error: "Cloudflare Access is not configured"
    };
  if (access.status === "missing_jwt")
    return {
      code: "ACCESS_LOGIN_REQUIRED",
      error: "Not logged in through Cloudflare Access"
    };
  return {
    code: "ACCESS_JWT_REJECTED",
    error: "Cloudflare Access JWT rejected"
  };
}

async function routeAccessDiagnostic(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  const auth = await authenticate(request, env);
  return json(accessDiagnostic(request, env), auth.identity ? 200 : 401);
}

async function routeApi(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.identity) return json(authenticationError(auth.access), 401);
  const incoming = new URL(request.url);
  const internalPath = incoming.pathname.replace(/^\/api/, "") || "/";
  const internalUrl = new URL(internalPath + incoming.search, incoming.origin);
  const id = env.REELHAUS_MANAGER.idFromName("reelhaus-manager");
  const headers = new Headers(request.headers);
  headers.delete("x-reelhaus-approver");
  headers.set("x-reelhaus-approver", auth.identity);
  return env.REELHAUS_MANAGER.get(id).fetch(
    new Request(internalUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual"
    })
  );
}

async function runScheduledDiscovery(env: WorkerEnv): Promise<void> {
  const id = env.REELHAUS_MANAGER.idFromName("reelhaus-manager");
  const response = await env.REELHAUS_MANAGER.get(id).fetch(
    new Request("https://internal/discovery/run", { method: "POST" })
  );
  if (!response.ok) {
    console.error("Scheduled discovery failed", { status: response.status });
  } else {
    const result = (await response.json()) as {
      processed?: number;
      created?: number;
      failed?: number;
    };
    console.log("Scheduled discovery completed", result);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      if (!isKnownApiRoute(request.method, url.pathname))
        return json({ error: "Not found" }, 404);
      if (
        request.method === "GET" &&
        url.pathname === "/api/auth/diagnostic"
      )
        return routeAccessDiagnostic(request, env);
      return routeApi(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "Method not allowed" }, 405);
    return env.ASSETS.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runScheduledDiscovery(env));
  }
} satisfies ExportedHandler<WorkerEnv>;
