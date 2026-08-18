import { describe, expect, it } from "vitest";
import type { ReelScanCustomerReport } from "./reelscan-customer-report";
import type { ReelFixComparisonResult } from "./reelfix-comparison";
import {
  buildReelFixProofReport,
  renderReelFixProofReportHtml,
  type ReelFixProofReportInput
} from "./reelfix-proof-report";

function customerReport(
  overrides: Partial<ReelScanCustomerReport> = {}
): ReelScanCustomerReport {
  return {
    businessName: "Le Petit Café",
    websiteUrl: "https://lepetitcafe.example/",
    scoreOutOf100: 84,
    recommendation: {
      action: "ReelCare",
      explanation:
        "Your website is in strong shape — ongoing light maintenance will help it stay that way."
    },
    highlights: [],
    opportunities: [],
    ...overrides
  };
}

function comparison(overrides: Partial<ReelFixComparisonResult> = {}): ReelFixComparisonResult {
  return {
    resolved: [],
    remaining: [],
    newIssues: [],
    needsReview: [],
    strengths: [],
    technicalHealthScore: { before: 57, after: 84 },
    ...overrides
  };
}

function baseInput(
  overrides: Partial<ReelFixComparisonResult> = {},
  reportOverrides: Partial<ReelScanCustomerReport> = {}
): ReelFixProofReportInput {
  return {
    businessName: "Le Petit Café",
    websiteUrl: "https://lepetitcafe.example/",
    verificationDate: "2026-08-19T10:00:00.000Z",
    baselineReport: customerReport({ scoreOutOf100: 57 }),
    verificationReport: customerReport(reportOverrides),
    comparison: comparison(overrides)
  };
}

describe("buildReelFixProofReport", () => {
  it("10. keeps Technical Website Health secondary — score never appears in the headline", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [
          { area: "Getting visitors to take action", whatWeFound: "The contact form now has labels." }
        ]
      })
    );
    expect(report.whatChanged).not.toMatch(/57/);
    expect(report.whatChanged).not.toMatch(/84/);
    expect(report.whatChanged).not.toMatch(/->|→/);
    expect(report.technicalHealth).toEqual({ before: 57, after: 84 });
  });

  it("never claims 'all issues fixed' — uses conservative 'verified improvements' wording", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [{ area: "Mobile experience", whatWeFound: "x" }]
      })
    );
    expect(report.whatChanged.toLowerCase()).toContain("verified improvements");
    expect(report.whatChanged.toLowerCase()).not.toContain("all issues");
  });

  it("does not overclaim when nothing was confirmed resolved", () => {
    const report = buildReelFixProofReport(
      baseInput({
        remaining: [{ area: "Technical health", whatWeFound: "x" }]
      })
    );
    expect(report.whatChanged.toLowerCase()).not.toContain("verified improvements were made");
  });

  it("maps resolved items to improvementsCompleted with area/before/after fields, never a fabricated specific claim", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [
          {
            area: "Explaining what you offer",
            whatWeFound: "The menu was not linked from the homepage."
          }
        ]
      })
    );
    expect(report.improvementsCompleted).toHaveLength(1);
    expect(report.improvementsCompleted[0]).toEqual({
      area: "Explaining what you offer",
      whatWasWrong: "The menu was not linked from the homepage.",
      nowImproved: "This was not detected again in the verification scan."
    });
  });

  it("puts remaining AND needs-review items together under stillToReview, never a more assertive bucket", () => {
    const report = buildReelFixProofReport(
      baseInput({
        remaining: [{ area: "Mobile experience", whatWeFound: "Still an issue." }],
        needsReview: [{ area: "First impression", whatWeFound: "Unconfirmed content judgment." }]
      })
    );
    expect(report.stillToReview).toHaveLength(2);
    expect(report.newIssues).toHaveLength(0);
  });

  it("11. never leaks internal sales metadata (businessFit, businessSegment, improvementNeed, salesRecommendation, reviewDecision)", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [{ area: "Mobile experience", whatWeFound: "x" }],
        remaining: [{ area: "Technical health", whatWeFound: "y" }]
      })
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("businessFit");
    expect(serialized).not.toContain("businessSegment");
    expect(serialized).not.toContain("improvementNeed");
    expect(serialized).not.toContain("salesRecommendation");
    expect(serialized).not.toContain("reviewDecision");
    expect(serialized).not.toContain("Contact");
    expect(serialized).not.toContain("Research more");
  });

  it("12. never leaks raw technical/AI metadata (evidenceIds, collector, analysisRunId, scoreImpact, raw evidence, model metadata)", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [{ area: "Mobile experience", whatWeFound: "x" }],
        newIssues: [{ area: "Technical health", whatWeFound: "y" }]
      })
    );
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      "evidenceIds",
      "collector",
      "analysisRunId",
      "scoreImpact",
      "confidence",
      "model",
      "promptVersion",
      "rootFindingKey",
      "sourceUrl"
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("reuses the verification scan's own customer-safe recommendation text for the next-recommendation section", () => {
    const report = buildReelFixProofReport(
      baseInput(
        {},
        {
          recommendation: {
            action: "ReelFix",
            explanation:
              "Your website works well overall — a few specific, quick fixes would remove friction for visitors."
          }
        }
      )
    );
    expect(report.nextRecommendation.headline).toBe(
      "Verification scan completed."
    );
    expect(report.nextRecommendation.explanation).toContain(
      "a few specific, quick fixes"
    );
  });

  it("caps the strengths section to a short list", () => {
    const report = buildReelFixProofReport(
      baseInput({
        strengths: ["a", "b", "c", "d", "e", "f", "g"]
      })
    );
    expect(report.whatIsWorking.length).toBeLessThanOrEqual(5);
  });
});

describe("renderReelFixProofReportHtml", () => {
  it("produces a self-contained HTML document with no external resources", () => {
    const report = buildReelFixProofReport(
      baseInput({ resolved: [{ area: "Mobile experience", whatWeFound: "x" }] })
    );
    const html = renderReelFixProofReportHtml(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\/(?!lepetitcafe\.example)/);
  });

  it("escapes business-controlled text so it cannot inject markup", () => {
    const report = buildReelFixProofReport(
      baseInput({
        resolved: [
          {
            area: "Mobile experience",
            whatWeFound: '<img src=x onerror=alert(1)>'
          }
        ]
      })
    );
    const html = renderReelFixProofReportHtml(report);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps the score section visually secondary (present, but not the page's headline element)", () => {
    const report = buildReelFixProofReport(
      baseInput({ resolved: [{ area: "Mobile experience", whatWeFound: "x" }] })
    );
    const html = renderReelFixProofReportHtml(report);
    const headlineIndex = html.indexOf("headline");
    const scoreIndex = html.indexOf("Technical Website Health");
    expect(headlineIndex).toBeGreaterThan(-1);
    expect(scoreIndex).toBeGreaterThan(headlineIndex);
  });
});
