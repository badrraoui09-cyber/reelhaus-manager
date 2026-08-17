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

  it("classifies an unsupported-protocol URL as a harmless other_reference (not an explicit-unsafe rejection)", () => {
    const result = classifySubmittedLink("http://127.0.0.1/admin");
    expect(result.kind).toBe("other_reference");
    expect(result.normalizedUrl).toBeUndefined();
    expect(result.rejectedAsUnsafe).toBeUndefined();
  });

  it("classifies malformed input as other_reference, never throws", () => {
    const result = classifySubmittedLink("not a url at all");
    expect(result.kind).toBe("other_reference");
  });

  // Task #5A-fix §4: an explicit unsafe *website* URL attempt (private/
  // reserved hostname or IP, or credentials in the URL) is flagged for
  // outright rejection, not silently downgraded to a harmless reference —
  // see rejectedAsUnsafe and PublicIntakeService.submit().
  it.each([
    ["https://127.0.0.1/", "loopback IPv4"],
    ["https://169.254.169.254/latest/meta-data/", "cloud metadata address"],
    ["https://10.0.0.1/", "RFC1918 private IPv4"],
    ["https://localhost/", "blocked hostname"],
    ["https://[::1]/", "IPv6 loopback"]
  ])("flags %s (%s) as rejectedAsUnsafe, never as website", (url) => {
    const result = classifySubmittedLink(url);
    expect(result.kind).not.toBe("website");
    expect(result.rejectedAsUnsafe).toBe(true);
  });

  it("flags a credential-bearing URL as rejectedAsUnsafe", () => {
    const result = classifySubmittedLink("https://user:pass@example.com/");
    expect(result.rejectedAsUnsafe).toBe(true);
  });

  it("does not flag Instagram/Google Maps/random-text references as unsafe", () => {
    expect(
      classifySubmittedLink("https://instagram.com/lepetitcafe").rejectedAsUnsafe
    ).toBeUndefined();
    expect(
      classifySubmittedLink("https://maps.app.goo.gl/abcd1234").rejectedAsUnsafe
    ).toBeUndefined();
    expect(
      classifySubmittedLink("just some free text, no url here").rejectedAsUnsafe
    ).toBeUndefined();
  });

  it("always preserves the original raw value for context", () => {
    const result = classifySubmittedLink("https://instagram.com/lepetitcafe");
    expect(result.raw).toBe("https://instagram.com/lepetitcafe");
  });
});
