import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: vi.fn().mockRejectedValue(new Error("Browser Run unavailable"))
  }
}));

import { analyzePublicBusinessWebsite, robotsAllows } from "./browser-analysis";

describe("robots policy", () => {
  it("blocks disallowed paths for wildcard agents", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/private/a")).toBe(
      false
    );
  });

  it("allows public paths", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/menu")).toBe(true);
  });

  it("uses a conservative HTML fallback when Browser Run is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockResolvedValueOnce(
          new Response(
            '<html lang="fr"><head><title>Café Test</title></head><body><img src="/hero.jpg"><a href="mailto:hello@example.ma">Contact</a></body></html>',
            {
              status: 200,
              headers: { "content-type": "text/html" }
            }
          )
        )
    );
    const result = await analyzePublicBusinessWebsite(
      {} as Fetcher,
      "https://example.ma"
    );
    expect(result.title).toBe("Café Test");
    expect(result.publicEmails).toEqual(["hello@example.ma"]);
    expect(result.issues.map((issue) => issue.code)).toContain("mobile_viewport");
    expect(result.issues.map((issue) => issue.code)).toContain("image_alt");
  });
});

// Task #2.21 security audit — SSRF hardening regression tests. Before this
// fix, analyzePublicBusinessWebsite() accepted any http(s) URL with no
// private-IP/localhost/metadata-hostname check, and its HTML-fallback path
// followed redirects without re-validating them — the same gap
// url-safety.ts/safe-fetch.ts already closed for the public ReelScan
// intake path.
describe("analyzePublicBusinessWebsite SSRF hardening", () => {
  it("rejects a localhost target before making any network request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "https://localhost/admin")
    ).rejects.toThrow(/failed safety validation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a private/cloud-metadata IP target before making any network request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "https://169.254.169.254/latest/meta-data/")
    ).rejects.toThrow(/failed safety validation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a plain http:// target (https-only, matching url-safety.ts's policy)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "http://example.ma")
    ).rejects.toThrow(/failed safety validation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a URL carrying embedded credentials", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "https://user:pass@example.ma")
    ).rejects.toThrow(/failed safety validation/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not follow a redirect from a safe host to a private-IP host in the HTML fallback path", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // robots.txt lookup
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        // initial page fetch: redirects to a private-IP target
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" }
          })
        )
    );
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "https://example.ma")
    ).rejects.toThrow(/failed safety\/availability check/);
  });
});
