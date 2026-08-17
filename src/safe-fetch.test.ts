import { describe, expect, it } from "vitest";
import { safeFetchPublicUrl } from "./safe-fetch";

function fakeFetcher(
  handler: (url: string) => Response
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url);
  }) as typeof fetch;
}

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...headers }
  });
}

function redirectResponse(location: string) {
  return new Response(null, {
    status: 302,
    headers: { location }
  });
}

describe("safeFetchPublicUrl", () => {
  it("fetches a safe HTML page successfully", async () => {
    const fetcher = fakeFetcher(() => htmlResponse("<html>ok</html>"));
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toBe("<html>ok</html>");
      expect(result.finalUrl).toBe("https://example.com/");
      expect(result.redirectCount).toBe(0);
    }
  });

  it("rejects an unsafe initial URL without fetching anything", async () => {
    let called = false;
    const fetcher = fakeFetcher(() => {
      called = true;
      return htmlResponse("<html>should not be reached</html>");
    });
    const result = await safeFetchPublicUrl(fetcher, "https://127.0.0.1/");
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("follows a safe redirect chain and revalidates each hop", async () => {
    const fetcher = fakeFetcher((url) => {
      if (url === "https://example.com/") return redirectResponse("/next");
      if (url === "https://example.com/next")
        return htmlResponse("<html>final</html>");
      return new Response("not found", { status: 404 });
    });
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toBe("<html>final</html>");
      expect(result.finalUrl).toBe("https://example.com/next");
      expect(result.redirectCount).toBe(1);
    }
  });

  it("rejects a redirect into a private/internal address", async () => {
    const fetcher = fakeFetcher((url) => {
      if (url === "https://example.com/")
        return redirectResponse("http://169.254.169.254/latest/meta-data/");
      return htmlResponse("<html>unreachable</html>");
    });
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsafe_url");
  });

  it("detects a redirect loop", async () => {
    const fetcher = fakeFetcher((url) => {
      if (url === "https://example.com/a") return redirectResponse("/b");
      if (url === "https://example.com/b") return redirectResponse("/a");
      return new Response("not found", { status: 404 });
    });
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("redirect_loop");
  });

  it("enforces a maximum redirect count", async () => {
    const fetcher = fakeFetcher((url) => {
      const match = url.match(/\/hop(\d+)$/);
      const hop = match ? Number(match[1]) : 0;
      if (url === "https://example.com/") return redirectResponse("/hop1");
      return redirectResponse(`/hop${hop + 1}`);
    });
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/", {
      maxRedirects: 3
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_many_redirects");
  });

  it("rejects a non-HTML content type", async () => {
    const fetcher = fakeFetcher(
      () =>
        new Response("binary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
    );
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_content_type");
  });

  it("rejects content exceeding the byte cap even without a content-length header", async () => {
    const bigBody = "a".repeat(5000);
    const fetcher = fakeFetcher(() => htmlResponse(bigBody));
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/", {
      maxContentBytes: 1000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("content_too_large");
  });

  it("rejects when the declared content-length already exceeds the cap", async () => {
    const fetcher = fakeFetcher(() =>
      htmlResponse("short", { "content-length": "9999999" })
    );
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/", {
      maxContentBytes: 1000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("content_too_large");
  });

  it("surfaces a fetch failure (e.g. timeout/abort) as a safe error, not a throw", async () => {
    const fetcher = (async () => {
      throw new Error("The operation was aborted");
    }) as unknown as typeof fetch;
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("fetch_failed");
  });

  it("rejects a redirect response with no Location header", async () => {
    const fetcher = fakeFetcher(
      () => new Response(null, { status: 302 })
    );
    const result = await safeFetchPublicUrl(fetcher, "https://example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("redirect_missing_location");
  });
});
