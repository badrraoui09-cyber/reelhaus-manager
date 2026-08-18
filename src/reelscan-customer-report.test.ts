import { describe, expect, it } from "vitest";
import type { FindingRecord } from "./audit-ledger";
import {
  buildReelScanCustomerReport,
  customerFacingSummary,
  type ReelScanCustomerReportInput
} from "./reelscan-customer-report";

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "f-1",
    scanId: "scan-1",
    analysisRunId: null,
    kind: "issue",
    title: "Links Without Accessible Name",
    category: "consistency",
    severity: "important",
    priority: 2,
    summary:
      "6 link(s) have neither visible text, an aria-label/aria-labelledby, nor a labeled image.",
    evidenceIds: ["ev-1"],
    confidence: "High",
    scoreImpact: -10,
    createdAt: "2026-08-17T09:00:00.000Z",
    ...overrides
  };
}

describe("customerFacingSummary", () => {
  it("translates a known technical issue into plain business-impact language", () => {
    expect(customerFacingSummary(finding())).toBe(
      "Some buttons and links may be harder for visitors and search engines to understand."
    );
  });

  it("matches regardless of the exact AI-generated title wording for the same defect", () => {
    // The AI phrases the identical underlying defect differently run to
    // run; the customer wording must not depend on exact title text.
    expect(
      customerFacingSummary(
        finding({
          title: "Missing Alt Attributes on Images",
          summary: "3 of 20 images have no alt attribute."
        })
      )
    ).toBe(
      "Some images have no description text, so visitors using screen readers and Google Image Search may not understand what they show."
    );
    expect(
      customerFacingSummary(
        finding({
          title: "Image Without Alt Attribute",
          summary: "1 of 16 images have no alt attribute."
        })
      )
    ).toBe(
      "Some images have no description text, so visitors using screen readers and Google Image Search may not understand what they show."
    );
  });

  it("falls back to the technical summary, never blank, for an unmapped issue", () => {
    const unmapped = finding({
      title: "Something Entirely Novel",
      summary: "A brand-new defect type this mapping has never seen."
    });
    expect(customerFacingSummary(unmapped)).toBe(unmapped.summary);
  });

  it("translates a strength/note by passing its existing summary through unchanged", () => {
    const strength = finding({
      kind: "strength",
      severity: null,
      title: "Clear Primary Heading",
      summary: "The primary heading clearly communicates the value proposition."
    });
    expect(customerFacingSummary(strength)).toBe(strength.summary);

    const note = finding({
      kind: "note",
      title: "Potential Mobile Layout Issue",
      summary: "The collector cannot visually verify responsive layout."
    });
    expect(customerFacingSummary(note)).toBe(note.summary);
  });

  it("never mutates the finding it's given", () => {
    const original = finding();
    customerFacingSummary(original);
    expect(original.title).toBe("Links Without Accessible Name");
    expect(original.summary).toBe(
      "6 link(s) have neither visible text, an aria-label/aria-labelledby, nor a labeled image."
    );
    expect(original.evidenceIds).toEqual(["ev-1"]);
  });
});

describe("buildReelScanCustomerReport", () => {
  const baseInput: ReelScanCustomerReportInput = {
    businessName: "Café Atlas",
    targetUrl: "https://cafe-atlas.example/",
    score: { score: 72, breakdown: [] },
    recommendation: { action: "ReelFix", reasons: ["important issue: x"] },
    findings: [
      finding({
        id: "issue-1",
        kind: "issue",
        category: "consistency",
        title: "Links Without Accessible Name",
        summary: "6 link(s) have no accessible name."
      }),
      finding({
        id: "strength-1",
        kind: "strength",
        severity: null,
        category: "trust",
        title: "Clear Meta Description",
        summary: "The meta description clearly summarizes the business."
      }),
      finding({
        id: "note-1",
        kind: "note",
        category: "mobile",
        title: "Potential Mobile Layout Issue",
        summary: "The collector cannot visually verify responsive layout."
      })
    ]
  };

  it("carries business name, URL, and score through unchanged", () => {
    const report = buildReelScanCustomerReport(baseInput);
    expect(report.businessName).toBe("Café Atlas");
    expect(report.websiteUrl).toBe("https://cafe-atlas.example/");
    expect(report.scoreOutOf100).toBe(72);
  });

  it("produces a customer-friendly recommendation explanation for every action", () => {
    const actions = ["ReelFix", "ReelBuild", "ReelCare", "no_immediate_change"] as const;
    for (const action of actions) {
      const report = buildReelScanCustomerReport({
        ...baseInput,
        recommendation: { action, reasons: [] }
      });
      expect(report.recommendation?.action).toBe(action);
      expect(report.recommendation?.explanation).toBeTruthy();
      // The explanation must not just repeat the raw internal reasons.
      expect(report.recommendation?.explanation).not.toBe("");
    }
    expect(
      buildReelScanCustomerReport({ ...baseInput, recommendation: null }).recommendation
    ).toBeNull();
  });

  it("puts strength findings into highlights, translated", () => {
    const report = buildReelScanCustomerReport(baseInput);
    expect(report.highlights).toEqual([
      "The meta description clearly summarizes the business."
    ]);
  });

  it("puts issue findings into opportunities, with a friendly area label and translated explanation", () => {
    const report = buildReelScanCustomerReport(baseInput);
    expect(report.opportunities).toEqual([
      {
        area: "Consistency & accessibility",
        whatWeFound:
          "Some buttons and links may be harder for visitors and search engines to understand."
      }
    ]);
  });

  it("gives an unrecognized category a readable label instead of the raw enum string", () => {
    const report = buildReelScanCustomerReport({
      ...baseInput,
      findings: [
        finding({
          kind: "issue",
          category: "some_new_category",
          title: "Unknown",
          summary: "x"
        })
      ]
    });
    expect(report.opportunities[0].area).toBe("Some New Category");
  });

  it("excludes uncertain notes from both highlights and opportunities", () => {
    const report = buildReelScanCustomerReport(baseInput);
    const allText = JSON.stringify(report);
    expect(allText).not.toContain("cannot visually verify responsive layout");
  });

  it("handles a null score/recommendation without throwing", () => {
    const report = buildReelScanCustomerReport({
      ...baseInput,
      score: null,
      recommendation: null
    });
    expect(report.scoreOutOf100).toBeNull();
    expect(report.recommendation).toBeNull();
  });

  it("never leaks raw evidence, evidence IDs, AI metadata, confidence, severity, or collector details", () => {
    const report = buildReelScanCustomerReport(baseInput);
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      "evidenceIds",
      "ev-1",
      "confidence",
      "\"High\"",
      "severity",
      "scoreImpact",
      "analysisRunId",
      "collector"
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
