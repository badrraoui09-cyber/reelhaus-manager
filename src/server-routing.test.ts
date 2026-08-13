import { describe, expect, it } from "vitest";
import { isApiPath, isKnownApiRoute } from "./server-routing";

describe("Worker route classification", () => {
  it("recognizes protected API routes", () => {
    expect(isKnownApiRoute("GET", "/api/auth/diagnostic")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/sales")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/businesses/search")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/businesses/business-1/workspace")).toBe(
      true
    );
    expect(isKnownApiRoute("GET", "/api/reelscan/export")).toBe(true);
    expect(isKnownApiRoute("POST", "/api/scan")).toBe(true);
    expect(isKnownApiRoute("POST", "/api/leads/lead-1/do-not-contact")).toBe(
      true
    );
    expect(isKnownApiRoute("POST", "/api/leads/lead-1/quality-review")).toBe(
      true
    );
    expect(
      isKnownApiRoute("POST", "/api/discovery/candidates/candidate-1/reelscan")
    ).toBe(true);
    expect(
      isKnownApiRoute("POST", "/api/discovery/candidates/candidate-1/scan")
    ).toBe(true);
    expect(
      isKnownApiRoute("POST", "/api/discovery/candidates/candidate-1/decision")
    ).toBe(true);
  });

  it("keeps unknown API routes out of the SPA fallback", () => {
    expect(isApiPath("/api/not-a-route")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/not-a-route")).toBe(false);
    expect(isKnownApiRoute("GET", "/dashboard")).toBe(false);
  });

  it("does not classify browser routes as API paths", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/dashboard/leads")).toBe(false);
  });
});
