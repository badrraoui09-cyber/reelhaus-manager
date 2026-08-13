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
