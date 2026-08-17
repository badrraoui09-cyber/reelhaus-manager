// The complete, testable request-handling logic for POST/OPTIONS
// /api/public/reelscan. server.ts is a thin wrapper that extracts the real
// Request/env and calls handlePublicReelScanRequest() — everything here is
// injectable (store, AI binding, fetcher, secrets), so it's fully unit
// tested without a live Worker, live Turnstile, or a live Durable Object.
import type { AuditLedgerService } from "./audit-ledger";
import type { WorkersAiBinding } from "./ai-service";
import { readPublicRequestBody } from "./body-limit";
import { hashCallerKey } from "./caller-key";
import { evaluatePublicCors } from "./cors-policy";
import {
  TURNSTILE_ACTION,
  TURNSTILE_ALLOWED_HOSTNAMES
} from "./public-intake-config";
import { parsePublicReelScanRequestBody } from "./public-request-schema";
import { PublicIntakeService, type PublicIntakeDeps } from "./public-intake-service";
import type { PublicIntakeStore } from "./public-intake-store";
import { verifyTurnstileToken } from "./turnstile";

export type PublicIntakeErrorCode =
  | "invalid_request"
  | "verification_failed"
  | "rate_limited"
  | "try_again_later";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function errorResponse(
  code: PublicIntakeErrorCode,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  // Never anything beyond a stable public code — no stack traces, no
  // provider/SQL error text, no internal identifiers. See
  // docs/reelscan-public-intake-security.md §15.
  return jsonResponse({ ok: false, error: code }, status, corsHeaders);
}

export interface PublicIntakeRouteDeps {
  store: PublicIntakeStore;
  auditLedger: AuditLedgerService;
  ai: WorkersAiBinding | undefined;
  fetcher: typeof fetch;
  turnstileSecretKey: string | undefined;
  rateLimitPepper: string | undefined;
  callerIp: string | null;
}

export async function handlePublicReelScanRequest(
  request: Request,
  deps: PublicIntakeRouteDeps
): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = evaluatePublicCors(origin);

  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors.headers });

  const bodyResult = await readPublicRequestBody(request);
  if (!bodyResult.ok) return errorResponse("invalid_request", 400, cors.headers);

  const parsed = parsePublicReelScanRequestBody(bodyResult.text);
  if (!parsed.ok) return errorResponse("invalid_request", 400, cors.headers);

  // Fail closed: a missing secret or pepper is a server misconfiguration,
  // never a reason to silently skip verification/rate limiting.
  if (!deps.turnstileSecretKey || !deps.rateLimitPepper)
    return errorResponse("try_again_later", 503, cors.headers);

  const turnstile = await verifyTurnstileToken(
    deps.fetcher,
    deps.turnstileSecretKey,
    parsed.value.turnstileToken,
    {
      remoteIp: deps.callerIp || undefined,
      expectedHostnames: TURNSTILE_ALLOWED_HOSTNAMES,
      expectedAction: TURNSTILE_ACTION
    }
  );
  if (!turnstile.success)
    return errorResponse("verification_failed", 403, cors.headers);

  if (!deps.callerIp) return errorResponse("try_again_later", 503, cors.headers);
  const callerKey = await hashCallerKey(deps.callerIp, deps.rateLimitPepper);

  const serviceDeps: PublicIntakeDeps = {
    store: deps.store,
    auditLedger: deps.auditLedger,
    ai: deps.ai,
    fetcher: deps.fetcher
  };
  const outcome = await new PublicIntakeService(serviceDeps).submit(
    parsed.value,
    callerKey,
    origin
  );
  if (!outcome.accepted)
    return errorResponse(outcome.reason, 429, cors.headers);

  // Always the same minimal shape, regardless of what actually happened
  // internally (scan completed / still pending / needs target review) —
  // see docs/reelscan-public-intake-security.md §14.
  return jsonResponse({ ok: true, status: "received" }, 200, cors.headers);
}
