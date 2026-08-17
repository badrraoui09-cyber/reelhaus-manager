import { describe, expect, it } from "vitest";
import { evaluatePublicCors, publicCorsPreflightHeaders } from "./cors-policy";

describe("evaluatePublicCors", () => {
  it("allows the reelhaus.de origin", () => {
    const decision = evaluatePublicCors("https://reelhaus.de");
    expect(decision.allowed).toBe(true);
    expect(decision.headers["access-control-allow-origin"]).toBe(
      "https://reelhaus.de"
    );
  });

  it("allows the www subdomain", () => {
    const decision = evaluatePublicCors("https://www.reelhaus.de");
    expect(decision.allowed).toBe(true);
  });

  it("does not grant permissive CORS headers to an unknown origin", () => {
    const decision = evaluatePublicCors("https://evil.example.com");
    expect(decision.allowed).toBe(false);
    expect(decision.headers).toEqual({});
  });

  it("does not grant CORS headers when no origin is present", () => {
    const decision = evaluatePublicCors(null);
    expect(decision.allowed).toBe(false);
    expect(decision.headers).toEqual({});
  });

  it("never sets a wildcard origin or a credentials header", () => {
    const decision = evaluatePublicCors("https://reelhaus.de");
    expect(decision.headers["access-control-allow-origin"]).not.toBe("*");
    expect(decision.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("rejects a lookalike origin (subdomain confusion, no trailing slash tricks)", () => {
    expect(evaluatePublicCors("https://reelhaus.de.evil.com").allowed).toBe(
      false
    );
    expect(evaluatePublicCors("http://reelhaus.de").allowed).toBe(false); // wrong scheme
    expect(evaluatePublicCors("https://reelhaus.de:8080").allowed).toBe(
      false
    ); // explicit port not allow-listed
  });
});

describe("publicCorsPreflightHeaders", () => {
  it("returns explicit preflight headers for an allowed origin", () => {
    const headers = publicCorsPreflightHeaders("https://reelhaus.de");
    expect(headers["access-control-allow-methods"]).toContain("POST");
    expect(headers["access-control-allow-headers"]).toContain("content-type");
  });

  it("returns no headers for a disallowed origin", () => {
    expect(publicCorsPreflightHeaders("https://evil.example.com")).toEqual({});
  });
});
