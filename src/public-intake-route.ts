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
  PRE_TURNSTILE_ATTEMPT_LIMIT,
  TURNSTILE_ACTION,
  TURNSTILE_ALLOWED_HOSTNAMES,
  VERIFICATION_ATTEMPT_KEY_PREFIX
} from "./public-intake-config";
import { parsePublicReelScanRequestBody } from "./public-request-schema";
import { PublicIntakeService, type PublicIntakeDeps } from "./public-intake-service";
import type { PublicIntakeStore } from "./public-intake-store";
import { evaluateRateLimit } from "./rate-limit";
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
  /** See PublicIntakeDeps.scheduleQueueProcessing (public-intake-service.ts). */
  scheduleQueueProcessing: () => Promise<void>;
}

export async function handlePublicReelScanRequest(
  request: Request,
  deps: PublicIntakeRouteDeps
): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = evaluatePublicCors(origin);

  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors.headers });

  // Everything past this point can call into SQLite (public-intake-store.ts),
  // the audit ledger, Turnstile's siteverify, or Workers AI — any of which
  // can throw in a way this route did not anticipate. The public boundary
  // must still fail generically, not leak that exception's `.message` (SQL
  // text, provider errors, stack traces, ...). This is defense layer one;
  // sales-agent.ts's outer catch is layer two in case this one is bypassed.
  try {
    const bodyResult = await readPublicRequestBody(request);
    if (!bodyResult.ok)
      return errorResponse("invalid_request", 400, cors.headers);

    const parsed = parsePublicReelScanRequestBody(bodyResult.text);
    if (!parsed.ok) return errorResponse("invalid_request", 400, cors.headers);

    // Fail closed: a missing secret or pepper is a server misconfiguration,
    // never a reason to silently skip verification/rate limiting.
    if (!deps.turnstileSecretKey || !deps.rateLimitPepper)
      return errorResponse("try_again_later", 503, cors.headers);

    if (!deps.callerIp) return errorResponse("try_again_later", 503, cors.headers);
    const callerKey = await hashCallerKey(deps.callerIp, deps.rateLimitPepper);

    // Pre-Turnstile abuse hardening: a conservative, separate attempt limit
    // evaluated BEFORE calling out to Cloudflare's siteverify, so unlimited
    // syntactically-valid requests with fake tokens can't force unlimited
    // verification traffic. Same synchronous read -> decide -> write
    // atomicity as every other counter here; a distinct key namespace keeps
    // this fully independent from the accepted-request window below.
    const attemptKey = `${VERIFICATION_ATTEMPT_KEY_PREFIX}${callerKey}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const attemptWindow = deps.store.getRateLimitWindow(attemptKey);
    const attemptDecision = evaluateRateLimit(
      attemptWindow,
      nowSeconds,
      PRE_TURNSTILE_ATTEMPT_LIMIT.maxAttemptsPerWindow,
      PRE_TURNSTILE_ATTEMPT_LIMIT.windowSeconds
    );
    if (!attemptDecision.allowed)
      return errorResponse("rate_limited", 429, cors.headers);
    deps.store.touchRateLimitWindow(
      attemptKey,
      nowSeconds,
      PRE_TURNSTILE_ATTEMPT_LIMIT.windowSeconds
    );

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

    const serviceDeps: PublicIntakeDeps = {
      store: deps.store,
      auditLedger: deps.auditLedger,
      ai: deps.ai,
      fetcher: deps.fetcher,
      scheduleQueueProcessing: deps.scheduleQueueProcessing
    };
    const outcome = await new PublicIntakeService(serviceDeps).submit(
      parsed.value,
      callerKey,
      origin
    );
    if (!outcome.accepted)
      return errorResponse(
        outcome.reason,
        outcome.reason === "invalid_request" ? 400 : 429,
        cors.headers
      );

    // Always the same minimal shape, regardless of what actually happened
    // internally (scan completed / still pending / needs target review) —
    // see docs/reelscan-public-intake-security.md §14.
    return jsonResponse({ ok: true, status: "received" }, 200, cors.headers);
  } catch {
    // Deliberately no error detail of any kind reaches the caller — see
    // docs/reelscan-public-intake-security.md §12.
    return errorResponse("try_again_later", 503, cors.headers);
  }
}
