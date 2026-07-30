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

  it("surfaces Browser Run failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 }))
    );
    await expect(
      analyzePublicBusinessWebsite({} as Fetcher, "https://example.ma")
    ).rejects.toThrow("Browser Run unavailable");
  });
});
