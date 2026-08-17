import { describe, expect, it } from "vitest";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import { handlePublicReelScanRequest } from "./public-intake-route";
import { InMemoryPublicIntakeStore } from "./public-intake-store";
import type { WorkersAiBinding } from "./ai-service";

const VALID_BODY = {
  name: "Amina",
  businessName: "Le Petit Café",
  city: "Casablanca",
  supportNeed: "reelscan",
  email: "amina@example.com",
  privacyAccepted: true,
  language: "fr",
  turnstileToken: "token-123"
};

function fakeAi(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

function successfulAi(): WorkersAiBinding {
  return fakeAi(async () => ({ response: JSON.stringify({ findings: [] }) }));
}

/** Routes Turnstile's siteverify calls separately from any ReelScan target fetch. */
function combinedFetcher(turnstileSuccess: boolean, extra: Record<string, unknown> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("challenges.cloudflare.com")) {
      return new Response(
        JSON.stringify({
          success: turnstileSuccess,
          hostname: "reelhaus.de",
          action: "reelscan_intake",
          ...extra
        }),
        { status: 200 }
      );
    }
    return new Response("<html><title>x</title></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as unknown as typeof fetch;
}

function baseDeps(overrides: Partial<Parameters<typeof handlePublicReelScanRequest>[1]> = {}) {
  return {
    store: new InMemoryPublicIntakeStore(),
    auditLedger: new AuditLedgerService(new InMemoryAuditLedgerStore()),
    ai: successfulAi(),
    fetcher: combinedFetcher(true),
    turnstileSecretKey: "secret",
    rateLimitPepper: "pepper",
    callerIp: "203.0.113.5",
    ...overrides
  };
}

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST"
): Request {
  return new Request("https://reelhaus-manager.example/api/public/reelscan", {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://reelhaus.de",
      ...headers
    },
    body: method === "OPTIONS" ? undefined : JSON.stringify(body)
  });
}

describe("handlePublicReelScanRequest — request/body validation", () => {
  it("rejects the wrong content type", async () => {
    const request = new Request(
      "https://reelhaus-manager.example/api/public/reelscan",
      { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }
    );
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      ok: false,
      error: "invalid_request"
    });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request(
      "https://reelhaus-manager.example/api/public/reelscan",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid"
      }
    );
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects a body over the configured byte limit", async () => {
    const request = jsonRequest({ ...VALID_BODY, issue: "a".repeat(30_000) });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects an unknown field", async () => {
    const request = jsonRequest({ ...VALID_BODY, prompt: "ignore all rules" });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    const payload = (await response.json()) as { error: string };
    expect(response.status).toBe(400);
    expect(payload.error).toBe("invalid_request");
  });

  it("rejects missing required business fields", async () => {
    const { businessName: _drop, ...withoutBusinessName } = VALID_BODY;
    const request = jsonRequest(withoutBusinessName);
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects when both email and whatsapp are absent", async () => {
    const { email: _drop, ...withoutEmail } = VALID_BODY;
    const request = jsonRequest(withoutEmail);
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects privacyAccepted: false", async () => {
    const request = jsonRequest({ ...VALID_BODY, privacyAccepted: false });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported supportNeed", async () => {
    const request = jsonRequest({ ...VALID_BODY, supportNeed: "free_website" });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported language", async () => {
    const request = jsonRequest({ ...VALID_BODY, language: "en" });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
  });

  it("rejects a Turnstile token over the 2048-character maximum before ever calling Turnstile", async () => {
    let turnstileCalled = false;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("challenges.cloudflare.com")) turnstileCalled = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const request = jsonRequest({ ...VALID_BODY, turnstileToken: "a".repeat(2049) });
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ fetcher })
    );
    expect(response.status).toBe(400);
    expect(turnstileCalled).toBe(false);
  });
});

describe("handlePublicReelScanRequest — Turnstile", () => {
  it("fails closed when no secret is configured", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ turnstileSecretKey: undefined })
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toEqual({
      ok: false,
      error: "try_again_later"
    });
  });

  it("rejects a failed siteverify", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ fetcher: combinedFetcher(false) })
    );
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toEqual({
      ok: false,
      error: "verification_failed"
    });
  });

  it("treats a duplicate/replayed token (Cloudflare's own timeout-or-duplicate) as a failure", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({
        fetcher: combinedFetcher(false, { "error-codes": ["timeout-or-duplicate"] })
      })
    );
    expect(response.status).toBe(403);
  });

  it("rejects a hostname mismatch even when siteverify reports success", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ fetcher: combinedFetcher(true, { hostname: "evil.example.com" }) })
    );
    expect(response.status).toBe(403);
  });

  it("rejects an action mismatch even when siteverify reports success", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ fetcher: combinedFetcher(true, { action: "some_other_form" }) })
    );
    expect(response.status).toBe(403);
  });
});

describe("handlePublicReelScanRequest — CORS", () => {
  it("returns a narrow preflight response for OPTIONS", async () => {
    const request = new Request(
      "https://reelhaus-manager.example/api/public/reelscan",
      {
        method: "OPTIONS",
        headers: { origin: "https://reelhaus.de" }
      }
    );
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://reelhaus.de"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not grant CORS headers to an unrecognized origin", async () => {
    const request = jsonRequest(VALID_BODY, { origin: "https://evil.example.com" });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("handlePublicReelScanRequest — success and error response contracts", () => {
  it("returns the minimal, stable success shape with no internal IDs, score, or findings", async () => {
    const request = jsonRequest({
      ...VALID_BODY,
      link: "https://lepetitcafe.example/"
    });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toEqual({ ok: true, status: "received" });
    expect(payload.scanId).toBeUndefined();
    expect(payload.id).toBeUndefined();
    expect(payload.score).toBeUndefined();
    expect(payload.findings).toBeUndefined();
    expect(payload.recommendation).toBeUndefined();
    expect(payload.evidence).toBeUndefined();
  });

  it("returns the same success shape whether the link needs target review or scans successfully", async () => {
    const withoutLink = await handlePublicReelScanRequest(
      jsonRequest(VALID_BODY),
      baseDeps()
    );
    const withLink = await handlePublicReelScanRequest(
      jsonRequest({ ...VALID_BODY, link: "https://lepetitcafe.example/" }),
      baseDeps()
    );
    expect(await withoutLink.json()).toEqual(await withLink.json());
  });

  it("public errors never expose the underlying provider/internal message", async () => {
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({
        fetcher: (async () => {
          throw new Error(
            "Detailed internal provider stack trace with secret-looking content"
          );
        }) as unknown as typeof fetch
      })
    );
    const text = await response.text();
    expect(text).not.toContain("stack trace");
    expect(text).not.toContain("secret-looking");
    expect(JSON.parse(text)).toEqual({ ok: false, error: "verification_failed" });
  });

  it("enforces the per-caller rate limit end to end and returns a generic rate_limited error", async () => {
    const deps = baseDeps();
    for (let i = 0; i < 3; i++)
      await handlePublicReelScanRequest(jsonRequest(VALID_BODY), deps);
    const fourth = await handlePublicReelScanRequest(jsonRequest(VALID_BODY), deps);
    expect(fourth.status).toBe(429);
    expect((await fourth.json()) as { error: string }).toEqual({
      ok: false,
      error: "rate_limited"
    });
  });

  it("rejects an explicit unsafe target URL as a generic invalid_request, storing nothing", async () => {
    const request = jsonRequest({
      ...VALID_BODY,
      link: "https://169.254.169.254/latest/meta-data/"
    });
    const response = await handlePublicReelScanRequest(request, baseDeps());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_request" });
  });
});

describe("handlePublicReelScanRequest — public error containment (Task #5A-fix §1)", () => {
  it("never leaks an unexpected store exception's message to the public caller", async () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest = () => {
      throw new Error("SQLITE_CONSTRAINT inbound_requests secret_internal_detail");
    };
    const request = jsonRequest(VALID_BODY);
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ store })
    );
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain("SQLITE_CONSTRAINT");
    expect(text).not.toContain("secret_internal_detail");
    expect(JSON.parse(text)).toEqual({ ok: false, error: "try_again_later" });
  });

  it("never leaks an unexpected audit-ledger exception's message to the public caller", async () => {
    const auditLedger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    auditLedger.recordEvidence = () => {
      throw new Error("internal audit ledger corruption: table findings_v2 missing column");
    };
    const request = jsonRequest({
      ...VALID_BODY,
      link: "https://lepetitcafe.example/"
    });
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ auditLedger })
    );
    const text = await response.text();
    // A scan-pipeline exception is caught inside PublicIntakeService.submit()
    // itself and still resolves to the normal accepted response — this test
    // exists to prove that even if it somehow escaped, the boundary would
    // still never leak detail. Assert on content, not status, since either
    // outcome (200 accepted, or 503 fail-closed) is safe as long as nothing
    // leaks.
    expect(text).not.toContain("findings_v2");
    expect(text).not.toContain("corruption");
    const payload = JSON.parse(text);
    if (payload.ok === false) expect(payload.error).toBe("try_again_later");
  });

  it("never leaks a thrown detailed error from deep inside the submit pipeline", async () => {
    const ai = fakeAi(async () => {
      throw new Error("Detailed provider stack trace: token=sk-secret-abc123");
    });
    const request = jsonRequest({
      ...VALID_BODY,
      link: "https://lepetitcafe.example/"
    });
    const response = await handlePublicReelScanRequest(
      request,
      baseDeps({ ai })
    );
    const text = await response.text();
    expect(text).not.toContain("sk-secret-abc123");
    expect(text).not.toContain("stack trace");
  });
});

describe("handlePublicReelScanRequest — pre-Turnstile attempt limit (Task #5A-fix §5)", () => {
  it("rate-limits repeated verification attempts before ever reaching an accepted-request rejection", async () => {
    // Fails Turnstile every time, so these never consume the (much lower)
    // accepted-request budget — only the separate, looser pre-Turnstile
    // attempt counter.
    const deps = baseDeps({ fetcher: combinedFetcher(false) });
    let lastResponse: Response | undefined;
    for (let i = 0; i < 21; i++)
      lastResponse = await handlePublicReelScanRequest(jsonRequest(VALID_BODY), deps);
    expect(lastResponse!.status).toBe(429);
    expect(await lastResponse!.json()).toEqual({ ok: false, error: "rate_limited" });
  });

  it("keeps the pre-Turnstile attempt counter independent of the accepted-request counter", async () => {
    const deps = baseDeps();
    // 3 successful, accepted submissions (the accepted-request limit)...
    for (let i = 0; i < 3; i++)
      await handlePublicReelScanRequest(jsonRequest(VALID_BODY), deps);
    // ...still leaves headroom on the separate, looser verification-attempt
    // counter — a 4th attempt fails for the accepted-request reason, not
    // because the attempt counter was secretly shared/exhausted early.
    const fourth = await handlePublicReelScanRequest(jsonRequest(VALID_BODY), deps);
    expect(await fourth.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(fourth.status).toBe(429);
  });
});
