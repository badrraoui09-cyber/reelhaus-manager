export { ReelHausManager } from "./sales-agent";
import { verifyCloudflareAccess } from "./access-auth";

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

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

async function identity(
  request: Request,
  env: WorkerEnv
): Promise<string | null> {
  const accessIdentity = await verifyCloudflareAccess(request, env);
  if (accessIdentity) return accessIdentity;
  if (
    String(env.ALLOW_LOCAL_BEARER_AUTH) === "true" &&
    env.GUARDIAN_API_TOKEN &&
    request.headers.get("authorization") === `Bearer ${env.GUARDIAN_API_TOKEN}`
  )
    return "local-token-user";
  return null;
}

async function routeApi(request: Request, env: WorkerEnv): Promise<Response> {
  const authenticatedIdentity = await identity(request, env);
  if (!authenticatedIdentity) {
    return json({ error: "Cloudflare Access or local bearer auth required" }, 401);
  }
  const incoming = new URL(request.url);
  const internalPath = incoming.pathname.replace(/^\/api/, "") || "/";
  const internalUrl = new URL(internalPath + incoming.search, incoming.origin);
  const id = env.REELHAUS_MANAGER.idFromName("reelhaus-manager");
  const headers = new Headers(request.headers);
  headers.delete("x-reelhaus-approver");
  headers.set("x-reelhaus-approver", authenticatedIdentity);
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
    if (url.pathname.startsWith("/api/")) return routeApi(request, env);
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
