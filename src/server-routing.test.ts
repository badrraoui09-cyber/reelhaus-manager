import { describe, expect, it } from "vitest";
import { isApiPath, isKnownApiRoute, isPublicApiRoute } from "./server-routing";

describe("Worker route classification", () => {
  it("recognizes protected API routes", () => {
    expect(isKnownApiRoute("GET", "/api/auth/diagnostic")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/ai/health")).toBe(true);
    expect(isKnownApiRoute("GET", "/api/audit/scans/scan-1")).toBe(true);
    expect(isKnownApiRoute("POST", "/api/reelscan/v1/client-zero")).toBe(
      true
    );
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

  it("recognizes the private inbound-requests Manager route", () => {
    expect(isKnownApiRoute("GET", "/api/inbound-requests")).toBe(true);
  });
});

describe("isPublicApiRoute — the one exact Access-bypassing exception", () => {
  it("allows exactly POST /api/public/reelscan", () => {
    expect(isPublicApiRoute("POST", "/api/public/reelscan")).toBe(true);
  });

  it("allows exactly OPTIONS /api/public/reelscan (CORS preflight)", () => {
    expect(isPublicApiRoute("OPTIONS", "/api/public/reelscan")).toBe(true);
  });

  it("does not bypass for a similarly-named but different path", () => {
    expect(isPublicApiRoute("POST", "/api/public/foo")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/public/reelscan/extra")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/public/reelscan/admin")).toBe(false);
    expect(isPublicApiRoute("GET", "/api/public/reelscan")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/public")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/publicreelscan")).toBe(false);
  });

  it("never overlaps with a known private route — the exception cannot expand via API_ROUTES", () => {
    const privateRoutes = [
      ["GET", "/api/sales"],
      ["GET", "/api/audit/scans/scan-1"],
      ["POST", "/api/reelscan/v1/client-zero"],
      ["GET", "/api/inbound-requests"],
      ["POST", "/api/assistant"]
    ] as const;
    for (const [method, pathname] of privateRoutes) {
      expect(isKnownApiRoute(method, pathname)).toBe(true);
      expect(isPublicApiRoute(method, pathname)).toBe(false);
    }
  });

  it("the public route is not itself a known private route", () => {
    expect(isKnownApiRoute("POST", "/api/public/reelscan")).toBe(false);
    expect(isKnownApiRoute("OPTIONS", "/api/public/reelscan")).toBe(false);
  });
});
