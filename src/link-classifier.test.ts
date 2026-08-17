import { describe, expect, it } from "vitest";
import { classifySubmittedLink } from "./link-classifier";

describe("classifySubmittedLink", () => {
  it("classifies an absent link as none", () => {
    expect(classifySubmittedLink(undefined).kind).toBe("none");
    expect(classifySubmittedLink(null).kind).toBe("none");
    expect(classifySubmittedLink("").kind).toBe("none");
    expect(classifySubmittedLink("   ").kind).toBe("none");
  });

  it("classifies a normal safe website and normalizes it", () => {
    const result = classifySubmittedLink("https://lepetitcafe.example/");
    expect(result.kind).toBe("website");
    expect(result.normalizedUrl).toBe("https://lepetitcafe.example/");
  });

  it("classifies an Instagram link and does not treat it as a website", () => {
    const result = classifySubmittedLink("https://instagram.com/lepetitcafe");
    expect(result.kind).toBe("instagram");
    expect(result.normalizedUrl).toBeUndefined();
  });

  it("classifies a Google Maps link and does not treat it as a website", () => {
    const result = classifySubmittedLink(
      "https://maps.app.goo.gl/abcd1234"
    );
    expect(result.kind).toBe("google_maps");
    expect(result.normalizedUrl).toBeUndefined();
  });

  it("classifies an unsafe URL as other_reference, never as website", () => {
    const result = classifySubmittedLink("http://127.0.0.1/admin");
    expect(result.kind).toBe("other_reference");
    expect(result.normalizedUrl).toBeUndefined();
  });

  it("classifies malformed input as other_reference, never throws", () => {
    const result = classifySubmittedLink("not a url at all");
    expect(result.kind).toBe("other_reference");
  });

  it("always preserves the original raw value for context", () => {
    const result = classifySubmittedLink("https://instagram.com/lepetitcafe");
    expect(result.raw).toBe("https://instagram.com/lepetitcafe");
  });
});
