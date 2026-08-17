import { describe, expect, it } from "vitest";
import { callerIpFromRequest, hashCallerKey } from "./caller-key";

describe("hashCallerKey", () => {
  it("produces a deterministic, non-reversible key for the same IP + pepper", async () => {
    const first = await hashCallerKey("203.0.113.5", "pepper-1");
    const second = await hashCallerKey("203.0.113.5", "pepper-1");
    expect(first).toBe(second);
    expect(first).not.toContain("203.0.113.5");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different keys for different IPs", async () => {
    const a = await hashCallerKey("203.0.113.5", "pepper-1");
    const b = await hashCallerKey("203.0.113.6", "pepper-1");
    expect(a).not.toBe(b);
  });

  it("produces different keys for the same IP under a different pepper", async () => {
    const a = await hashCallerKey("203.0.113.5", "pepper-1");
    const b = await hashCallerKey("203.0.113.5", "pepper-2");
    expect(a).not.toBe(b);
  });
});

describe("callerIpFromRequest", () => {
  it("uses CF-Connecting-IP, set by the edge and not spoofable by the caller", () => {
    const request = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.5" }
    });
    expect(callerIpFromRequest(request)).toBe("203.0.113.5");
  });

  it("never trusts a caller-supplied X-Forwarded-For", () => {
    const request = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "1.2.3.4" }
    });
    expect(callerIpFromRequest(request)).toBeNull();
  });
});
