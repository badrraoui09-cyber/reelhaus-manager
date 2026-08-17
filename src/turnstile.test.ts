import { describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "./turnstile";

function fakeFetcher(handler: () => Response): typeof fetch {
  return (async () => handler()) as typeof fetch;
}

describe("verifyTurnstileToken", () => {
  it("succeeds on a valid Cloudflare response", async () => {
    const fetcher = fakeFetcher(
      () => new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    const result = await verifyTurnstileToken(fetcher, "secret", "token-123");
    expect(result.success).toBe(true);
  });

  it("fails closed when Cloudflare reports failure", async () => {
    const fetcher = fakeFetcher(
      () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200 }
        )
    );
    const result = await verifyTurnstileToken(fetcher, "secret", "bad-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("invalid-input-response");
  });

  it("fails closed when no token is supplied", async () => {
    const fetcher = fakeFetcher(() => new Response("should not be called"));
    const result = await verifyTurnstileToken(fetcher, "secret", undefined);
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("missing-input-response");
  });

  it("fails closed when no secret is configured, without ever calling out", async () => {
    let called = false;
    const fetcher = fakeFetcher(() => {
      called = true;
      return new Response(JSON.stringify({ success: true }));
    });
    const result = await verifyTurnstileToken(fetcher, undefined, "token-123");
    expect(result.success).toBe(false);
    expect(called).toBe(false);
  });

  it("fails closed on a non-2xx response from Cloudflare", async () => {
    const fetcher = fakeFetcher(() => new Response("error", { status: 503 }));
    const result = await verifyTurnstileToken(fetcher, "secret", "token-123");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("http_503");
  });

  it("fails closed on malformed JSON from Cloudflare", async () => {
    const fetcher = fakeFetcher(() => new Response("not json", { status: 200 }));
    const result = await verifyTurnstileToken(fetcher, "secret", "token-123");
    expect(result.success).toBe(false);
  });

  it("fails closed on a network error", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await verifyTurnstileToken(fetcher, "secret", "token-123");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("network unreachable");
  });

  it("fails closed when verification exceeds its timeout", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetcher = ((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted"))
          );
        });
      }) as unknown as typeof fetch;

      const resultPromise = verifyTurnstileToken(
        fetcher,
        "secret",
        "token-123",
        undefined,
        2_000
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;
      expect(result.success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the token and secret as form-encoded fields, not JSON", async () => {
    const fetcher = (async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "content-type": "application/x-www-form-urlencoded"
      });
      const body = init?.body as URLSearchParams;
      expect(body.get("secret")).toBe("secret");
      expect(body.get("response")).toBe("token-123");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await verifyTurnstileToken(fetcher, "secret", "token-123");
    expect(result.success).toBe(true);
  });
});
