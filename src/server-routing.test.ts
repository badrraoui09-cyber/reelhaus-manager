import { describe, expect, it } from "vitest";
import {
  hasValidJsonContentType,
  isApiPath,
  isKnownApiRoute,
  isPublicApiRoute,
  rejectsForContentType
} from "./server-routing";

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

  it("recognizes the Task #2.7 internal report-preview route as private, not public", () => {
    expect(isKnownApiRoute("GET", "/api/inbound-requests/req-1/report")).toBe(
      true
    );
    expect(isPublicApiRoute("GET", "/api/inbound-requests/req-1/report")).toBe(
      false
    );
  });

  it("recognizes the Task #2.11 internal sales-decision route as private, not public — and leaves the #2.7 report route unchanged", () => {
    expect(
      isKnownApiRoute("GET", "/api/inbound-requests/req-1/sales-decision")
    ).toBe(true);
    expect(
      isPublicApiRoute("GET", "/api/inbound-requests/req-1/sales-decision")
    ).toBe(false);
    // #5: existing protected route behavior is unchanged by adding the
    // new route above it.
    expect(isKnownApiRoute("GET", "/api/inbound-requests/req-1/report")).toBe(
      true
    );
    expect(isPublicApiRoute("GET", "/api/inbound-requests/req-1/report")).toBe(
      false
    );
    expect(isKnownApiRoute("GET", "/api/inbound-requests")).toBe(true);
  });

  it("recognizes the Task #2.19 ReelFix verification-link and proof-report routes as private, not public", () => {
    expect(
      isKnownApiRoute("POST", "/api/inbound-requests/req-1/reelfix-verification")
    ).toBe(true);
    expect(
      isPublicApiRoute("POST", "/api/inbound-requests/req-1/reelfix-verification")
    ).toBe(false);
    expect(
      isKnownApiRoute("GET", "/api/inbound-requests/req-1/reelfix-proof")
    ).toBe(true);
    expect(
      isPublicApiRoute("GET", "/api/inbound-requests/req-1/reelfix-proof")
    ).toBe(false);
    // #5: existing protected routes stay unchanged.
    expect(isKnownApiRoute("GET", "/api/inbound-requests/req-1/report")).toBe(
      true
    );
    expect(
      isKnownApiRoute("GET", "/api/inbound-requests/req-1/sales-decision")
    ).toBe(true);
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

// Task #2.21 security audit (Section 8, CSRF/HTTP behavior) — before this
// fix, an Access-protected state-changing route had no Content-Type
// enforcement of its own, unlike the public intake route. A classic
// technique (a cross-site <form enctype="text/plain"> POST, crafted so
// its body still parses as JSON) relies on the target accepting a
// non-JSON content type.
describe("hasValidJsonContentType", () => {
  it("accepts an exact application/json content type", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(hasValidJsonContentType(request)).toBe(true);
  });

  it("accepts application/json with a charset parameter", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}"
    });
    expect(hasValidJsonContentType(request)).toBe(true);
  });

  it("rejects text/plain — the classic cross-site form-POST JSON-CSRF content type", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"decision":"approved"}'
    });
    expect(hasValidJsonContentType(request)).toBe(false);
  });

  it("rejects a form-urlencoded content type", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approved"
    });
    expect(hasValidJsonContentType(request)).toBe(false);
  });

  it("rejects a missing content type when a body is present", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "POST",
      body: "{}"
    });
    expect(hasValidJsonContentType(request)).toBe(false);
  });
});

describe("rejectsForContentType", () => {
  it("rejects a state-changing request with a non-JSON body", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: '{"status":"approved"}'
    });
    expect(rejectsForContentType(request)).toBe(true);
  });

  it("does not reject a legitimate bodyless POST (e.g. the dashboard's own /api/scan call)", () => {
    const request = new Request("https://internal/api/scan", { method: "POST" });
    expect(rejectsForContentType(request)).toBe(false);
  });

  it("does not reject a legitimate application/json POST", () => {
    const request = new Request("https://internal/api/leads/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"status":"approved"}'
    });
    expect(rejectsForContentType(request)).toBe(false);
  });

  it("does not reject a GET request regardless of content type", () => {
    const request = new Request("https://internal/api/sales", {
      method: "GET",
      headers: { "content-type": "text/plain" }
    });
    expect(rejectsForContentType(request)).toBe(false);
  });
});
