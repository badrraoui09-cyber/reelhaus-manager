import { describe, expect, it } from "vitest";
import type { EvidenceRecord, FindingRecord } from "./audit-ledger";
import {
  analyzeCommercialContext,
  type CommercialAnalysisInput
} from "./reelscan-commercial-analysis";

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "f-1",
    scanId: "scan-1",
    analysisRunId: null,
    kind: "issue",
    title: "x",
    category: "technical",
    severity: "important",
    priority: 2,
    summary: "x",
    evidenceIds: ["ev-1"],
    createdAt: "2026-08-18T00:00:00.000Z",
    ...overrides
  };
}

// Task #2.18 — a verified, deterministic-collector evidence record: the
// only kind that can back a critical foundational finding into ReelBuild.
function verifiedFoundationalEvidence(
  overrides: Partial<EvidenceRecord> = {}
): EvidenceRecord {
  return {
    id: "ev-1",
    scanId: "scan-1",
    sourceType: "html_static",
    sourceUrl: "https://example.com/",
    observationType: "metadata",
    observation: "No page title or meta description found anywhere on the page.",
    capturedAt: "2026-08-18T00:00:00.000Z",
    collector: "reelscan-v1@generic-website-checks",
    metadata: { severity: "critical", verification: "verified" },
    ...overrides
  };
}

// An AI content-quality judgment: cites only unverified/manual-review
// evidence, never a deterministic collector — the exact Riad Kniza shape.
function unverifiedContentEvidence(
  overrides: Partial<EvidenceRecord> = {}
): EvidenceRecord {
  return {
    id: "ev-1",
    scanId: "scan-1",
    sourceType: "html_static",
    sourceUrl: "https://example.com/",
    observationType: "hero_text_excerpt",
    observation: "Bienvenue chez nous.",
    capturedAt: "2026-08-18T00:00:00.000Z",
    collector: "reelscan-v1@ai-content-signals",
    metadata: { verification: "inference" },
    ...overrides
  };
}

function baseInput(overrides: Partial<CommercialAnalysisInput> = {}): CommercialAnalysisInput {
  return {
    businessName: "Café Atlas",
    score: { score: 60, breakdown: [] },
    recommendation: { action: "ReelFix", reasons: [] },
    findings: [],
    ...overrides
  };
}

describe("analyzeCommercialContext", () => {
  it("1. independent restaurant with technical (non-foundational) issues -> high opportunity + ReelFix", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [
          finding({ category: "consistency", severity: "important" }),
          finding({ category: "technical", severity: "important" })
        ]
      })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.recommendedService).toBe("ReelFix");
    expect(result.explanation.toLowerCase()).toContain("independent");
    expect(result.explanation).not.toMatch(/html|aria|alt attribute|canonical|accessib/i);
  });

  it("2. luxury international hotel -> low opportunity + No action, even with ReelFix-level findings", () => {
    const result = analyzeCommercialContext(
      baseInput({
        businessName: "Royal Palace Resort",
        category: "luxury international hotel",
        score: { score: 50, breakdown: [] },
        recommendation: { action: "ReelFix", reasons: ["important issue: x"] },
        findings: [
          finding({ category: "technical", severity: "important" }),
          finding({ category: "consistency", severity: "important" })
        ]
      })
    );
    expect(result.opportunityLevel).toBe("low");
    expect(result.recommendedService).toBe("No action");
    expect(result.explanation).toContain("outside ReelHaus's realistic target market");
  });

  it("3. strong independent website with low/no issues -> ReelCare", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "boutique riad",
        findings: [
          finding({ kind: "strength", severity: null, category: "trust" }),
          finding({ kind: "issue", severity: "optional", category: "trust" })
        ]
      })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.recommendedService).toBe("ReelCare");
    expect(result.explanation.toLowerCase()).toContain("strong");
  });

  it("4. missing website foundation (critical positioning/service_clarity issue, backed by verified deterministic evidence) -> ReelBuild", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent cafe",
        findings: [
          finding({ category: "positioning", severity: "critical", evidenceIds: ["ev-1"] })
        ],
        websiteEvidence: [verifiedFoundationalEvidence()]
      })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.recommendedService).toBe("ReelBuild");
    expect(result.explanation.toLowerCase()).toContain("foundation");
  });

  // Task #2.18 — P0 reliability fix. Real pilot validation (Riad Kniza,
  // Tasks #2.9/#2.12/#2.15) showed the SAME unmodified site swinging
  // between ReelFix and ReelBuild across separate runs because the AI's
  // own severity judgment for a content-quality finding varied. A
  // functional premium-independent riad with only an AI content-quality
  // concern (no deterministic evidence behind it) must not become
  // ReelBuild from that concern alone, however confidently the AI rated
  // it "critical".
  it("4b. functional premium-independent riad with only an AI content-quality concern -> cannot become ReelBuild from that concern alone", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "premium independent riad",
        findings: [
          finding({
            category: "positioning",
            severity: "critical",
            evidenceIds: ["ev-1"],
            summary: "The homepage's hero text doesn't clearly convey the offer."
          })
        ],
        websiteEvidence: [unverifiedContentEvidence()]
      })
    );
    expect(result.businessSegment).toBe("premium_independent");
    expect(result.recommendedService).not.toBe("ReelBuild");
    expect(result.recommendedService).toBe("ReelFix");
  });

  // Task #2.18 — genuinely missing foundational evidence must still be
  // able to reach ReelBuild: the gate is not a blanket ban, only a
  // requirement that it be evidence-backed.
  it("4c. genuinely missing foundational identity/service/action-path evidence -> ReelBuild still possible", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [
          finding({
            category: "service_clarity",
            severity: "critical",
            evidenceIds: ["ev-1"],
            summary: "No description of what the business offers appears anywhere on the page."
          })
        ],
        websiteEvidence: [
          verifiedFoundationalEvidence({
            observationType: "seo",
            observation: "No page title, meta description, or heading describing the business's offer."
          })
        ]
      })
    );
    expect(result.recommendedService).toBe("ReelBuild");
  });

  // Task #2.18 repeatability regression — the exact Riad Kniza shape: the
  // AI keeps rating the same underlying (unverified) content observation
  // "critical", but its wording/category choice for it drifts between
  // runs (positioning vs. service_clarity, different phrasing). Severity
  // is held constant here on purpose — improvementNeed's severity
  // weighting (Task #2.13, explicitly preserved) is allowed to move
  // ReelFix vs. ReelCare when severity itself genuinely differs; what must
  // never move, regardless of category/wording, is whether this alone can
  // reach ReelBuild.
  it("4d. different plausible AI category/wording for the same underlying (unverified) evidence converges on the same service tier", () => {
    const sharedEvidence = [unverifiedContentEvidence()];
    const runs = [
      finding({
        id: "run-a",
        category: "positioning",
        severity: "critical",
        evidenceIds: ["ev-1"],
        summary: "The homepage does not clearly say what is offered."
      }),
      finding({
        id: "run-b",
        category: "service_clarity",
        severity: "critical",
        evidenceIds: ["ev-1"],
        summary: "It's unclear what the business actually offers."
      }),
      finding({
        id: "run-c",
        category: "positioning",
        severity: "critical",
        evidenceIds: ["ev-1"],
        summary: "Visitors may struggle to understand the offer from the homepage alone."
      })
    ].map((f) =>
      analyzeCommercialContext(
        baseInput({
          category: "boutique riad",
          findings: [f],
          websiteEvidence: sharedEvidence
        })
      ).recommendedService
    );
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).not.toBe("ReelBuild");
  });

  it("5. the technical score is preserved verbatim and never modified", () => {
    const input = baseInput({
      score: { score: 87, breakdown: [{ findingId: "f-1", title: "x", points: -10 }] }
    });
    const frozenScore = Object.freeze({ ...input.score! });
    const result = analyzeCommercialContext({ ...input, score: frozenScore });
    expect(result.technical.technicalHealthScore).toBe(87);
    expect(result.technical.label).toBe("Technical Website Health");
    // Confirms nothing here throws trying to mutate a frozen score object,
    // and the input findings array is untouched.
    expect(input.findings).toEqual([]);
  });

  it("never labels the technical score as overall business quality", () => {
    const result = analyzeCommercialContext(baseInput());
    expect(result.technical.label).toBe("Technical Website Health");
    expect(result.technical.label.toLowerCase()).not.toContain("business quality");
    expect(result.technical.label.toLowerCase()).not.toContain("overall");
  });

  it("passes null score through as null, with low confidence", () => {
    const result = analyzeCommercialContext(
      baseInput({ score: null, category: "independent restaurant" })
    );
    expect(result.technical.technicalHealthScore).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.confidenceReason).toMatch(/score/i);
  });

  it("defaults to medium opportunity with low confidence when no business category is given", () => {
    const result = analyzeCommercialContext(baseInput({ category: undefined }));
    expect(result.opportunityLevel).toBe("medium");
    expect(result.confidence).toBe("low");
    expect(result.confidenceReason).toMatch(/category/i);
  });

  it("gives medium confidence for an ambiguous but present category", () => {
    const result = analyzeCommercialContext(baseInput({ category: "hotel" }));
    expect(result.opportunityLevel).toBe("medium");
    expect(result.confidence).toBe("medium");
  });

  it("does not simply copy reelscan's own recommendation.action", () => {
    // Same ReelFix recommendation from reelscan.ts, but a large/chain
    // category must still produce a different, independent business call.
    const input = baseInput({
      category: "luxury international hotel chain",
      recommendation: { action: "ReelFix", reasons: ["x"] },
      findings: [finding({ category: "technical", severity: "important" })]
    });
    const result = analyzeCommercialContext(input);
    expect(result.recommendedService).not.toBe(input.recommendation?.action);
    expect(result.recommendedService).toBe("No action");
  });

  it("explanation text avoids developer/HTML/accessibility jargon across all four service outcomes", () => {
    const jargon = /html|aria|dom|canonical|alt attribute|accessible name|viewport|meta description/i;
    const cases: CommercialAnalysisInput[] = [
      baseInput({
        category: "independent restaurant",
        findings: [finding({ category: "technical", severity: "important" })]
      }),
      baseInput({
        category: "luxury hotel chain",
        findings: [finding({ category: "technical", severity: "important" })]
      }),
      baseInput({ category: "independent cafe", findings: [] }),
      baseInput({
        category: "independent cafe",
        findings: [finding({ category: "positioning", severity: "critical" })]
      })
    ];
    for (const input of cases)
      expect(analyzeCommercialContext(input).explanation).not.toMatch(jargon);
  });
});

describe("Task #2.13 — sales decision layer + recommendation calibration fix", () => {
  it("example 1: independent restaurant with many meaningful issues -> Contact", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [
          finding({ category: "technical", severity: "important" }),
          finding({ category: "consistency", severity: "important" }),
          finding({ category: "trust", severity: "important" })
        ]
      })
    );
    expect(result.recommendedService).toBe("ReelFix");
    expect(result.salesDecision).toEqual({
      businessFit: "high",
      improvementNeed: "high",
      salesRecommendation: "Contact"
    });
  });

  it("example 2: independent boutique hotel with an excellent website -> Research more / ReelCare", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "boutique small hotel",
        findings: [finding({ category: "trust", severity: "optional" })]
      })
    );
    expect(result.recommendedService).toBe("ReelCare");
    expect(result.salesDecision).toEqual({
      businessFit: "high",
      improvementNeed: "medium",
      salesRecommendation: "Research more"
    });
  });

  it("example 3: luxury chain -> No action, regardless of technical findings", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "luxury hotel chain",
        findings: [
          finding({ category: "technical", severity: "important" }),
          finding({ category: "consistency", severity: "important" }),
          finding({ category: "trust", severity: "critical" })
        ]
      })
    );
    expect(result.recommendedService).toBe("No action");
    expect(result.salesDecision).toEqual({
      businessFit: "low",
      improvementNeed: "high",
      salesRecommendation: "No action"
    });
  });

  it("calibration fix: a single minor issue is no longer enough for ReelFix — only small issues means ReelCare", () => {
    // Task #2.12 pilot finding: a business with exactly one minor,
    // non-foundational issue (e.g. Dar Ahlam) getting the same ReelFix
    // pitch as a business with seven real defects was too blunt.
    const oneMinorIssue = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [finding({ category: "trust", severity: "important" })]
      })
    );
    expect(oneMinorIssue.recommendedService).toBe("ReelCare");
    expect(oneMinorIssue.salesDecision.improvementNeed).toBe("medium");

    const manyIssues = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [
          finding({ category: "trust", severity: "important" }),
          finding({ category: "technical", severity: "important" })
        ]
      })
    );
    expect(manyIssues.recommendedService).toBe("ReelFix");
    expect(manyIssues.salesDecision.improvementNeed).toBe("high");
  });

  it("a single critical (non-foundational) issue alone is enough for ReelFix/high need", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [finding({ category: "technical", severity: "critical" })]
      })
    );
    expect(result.recommendedService).toBe("ReelFix");
    expect(result.salesDecision.improvementNeed).toBe("high");
  });

  it("no meaningful issues at all -> No action for a good-fit business, with a correct (non-luxury) explanation", () => {
    const result = analyzeCommercialContext(
      baseInput({ category: "independent restaurant", findings: [] })
    );
    expect(result.recommendedService).toBe("No action");
    expect(result.salesDecision).toEqual({
      businessFit: "high",
      improvementNeed: "low",
      salesRecommendation: "Research more"
    });
    // The old bug: this branch used to always say "luxury brand," which
    // would have been false here.
    expect(result.explanation).not.toContain("luxury");
    expect(result.explanation).toContain("excellent");
  });

  it("a foundational critical issue still overrides straight to ReelBuild regardless of the weighted count, when evidence-backed", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        findings: [
          finding({ category: "positioning", severity: "critical", evidenceIds: ["ev-1"] })
        ],
        websiteEvidence: [verifiedFoundationalEvidence()]
      })
    );
    expect(result.recommendedService).toBe("ReelBuild");
  });

  it("established/medium-fit business: only a high improvement need reaches Contact, otherwise Research more", () => {
    const lowNeed = analyzeCommercialContext(
      baseInput({ category: "hotel", findings: [] })
    );
    expect(lowNeed.salesDecision).toMatchObject({
      businessFit: "medium",
      salesRecommendation: "Research more"
    });

    const highNeed = analyzeCommercialContext(
      baseInput({
        category: "hotel",
        findings: [
          finding({ category: "technical", severity: "important" }),
          finding({ category: "consistency", severity: "important" })
        ]
      })
    );
    expect(highNeed.salesDecision).toMatchObject({
      businessFit: "medium",
      salesRecommendation: "Contact"
    });
  });

  it("does not change the technical score passthrough", () => {
    const result = analyzeCommercialContext(
      baseInput({
        category: "independent restaurant",
        score: { score: 42, breakdown: [] }
      })
    );
    expect(result.technical.technicalHealthScore).toBe(42);
  });
});

describe("Task #2.16 — expanded business-fit calibration + business segment", () => {
  it("independent restaurant -> High fit / small_independent", () => {
    const result = analyzeCommercialContext(
      baseInput({ category: "independent restaurant" })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.businessSegment).toBe("small_independent");
  });

  it("café / coffee shop -> High fit", () => {
    expect(analyzeCommercialContext(baseInput({ category: "café" })).opportunityLevel).toBe(
      "high"
    );
    expect(
      analyzeCommercialContext(baseInput({ category: "cafe" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "coffee shop" })).opportunityLevel
    ).toBe("high");
  });

  it("hammam / spa -> High fit", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "hammam" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "spa" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "wellness spa" })).opportunityLevel
    ).toBe("high");
  });

  it("cooking school / culinary experience -> High fit", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "cooking school" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "culinary experience" }))
        .opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "food experience" })).opportunityLevel
    ).toBe("high");
  });

  it("boutique / eco lodge -> High fit", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "boutique hotel" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "eco lodge" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "lodge" })).opportunityLevel
    ).toBe("high");
  });

  it("hospitality-qualified tour/excursion -> High fit, but a bare generic tour category does not", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "culinary tour" })).opportunityLevel
    ).toBe("high");
    expect(
      analyzeCommercialContext(baseInput({ category: "food tour experience" }))
        .opportunityLevel
    ).toBe("high");
    // A generic, non-hospitality-qualified "tour" must not be swept in —
    // this is the exact false-positive the task warned against.
    expect(
      analyzeCommercialContext(baseInput({ category: "city bus tour operator" }))
        .opportunityLevel
    ).toBe("medium");
  });

  it("a bare broad word like 'experience' alone does not make an unrelated business High fit", () => {
    const result = analyzeCommercialContext(
      baseInput({ category: "customer experience consulting" })
    );
    expect(result.opportunityLevel).not.toBe("high");
    expect(result.businessSegment).not.toBe("small_independent");
    expect(result.businessSegment).not.toBe("premium_independent");
  });

  it("global luxury chain -> Low fit / large_or_chain", () => {
    const result = analyzeCommercialContext(
      baseInput({ category: "international luxury hotel chain" })
    );
    expect(result.opportunityLevel).toBe("low");
    expect(result.businessSegment).toBe("large_or_chain");
  });

  it("large hotel group / enterprise hospitality -> Low fit / large_or_chain", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "large hotel group" })).businessSegment
    ).toBe("large_or_chain");
    expect(
      analyzeCommercialContext(baseInput({ category: "enterprise hospitality" }))
        .businessSegment
    ).toBe("large_or_chain");
    expect(
      analyzeCommercialContext(baseInput({ category: "palace-scale resort" })).businessSegment
    ).toBe("large_or_chain");
  });

  it("premium independent riad -> High fit / premium_independent, not treated as a global luxury chain", () => {
    const result = analyzeCommercialContext(
      baseInput({ businessName: "Riad El Fenn", category: "luxury independent riad" })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.businessSegment).toBe("premium_independent");
    // The exact regression this task fixes: "luxury" alone must not force Low.
    expect(result.opportunityLevel).not.toBe("low");
  });

  it("small independent café -> High fit / small_independent (no premium styling word)", () => {
    const result = analyzeCommercialContext(
      baseInput({ category: "small independent café" })
    );
    expect(result.opportunityLevel).toBe("high");
    expect(result.businessSegment).toBe("small_independent");
  });

  it("unknown / unrecognized category -> Medium fit + unknown segment, not a confident guess", () => {
    const result = analyzeCommercialContext(baseInput({ category: "consulting firm" }));
    expect(result.opportunityLevel).toBe("medium");
    expect(result.businessSegment).toBe("unknown");
    expect(result.confidence).toBe("medium");
  });

  it("missing category -> Medium fit + unknown segment + Low confidence (honest about missing information)", () => {
    const result = analyzeCommercialContext(baseInput({ category: undefined }));
    expect(result.opportunityLevel).toBe("medium");
    expect(result.businessSegment).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.confidenceReason).toMatch(/category/i);
  });

  it("confidence reasons name the detected segment, not a generic placeholder", () => {
    expect(
      analyzeCommercialContext(baseInput({ category: "independent restaurant" }))
        .confidenceReason
    ).toMatch(/independent hospitality category detected/i);
    expect(
      analyzeCommercialContext(baseInput({ category: "luxury independent riad" }))
        .confidenceReason
    ).toMatch(/premium\/boutique hospitality category detected/i);
    expect(
      analyzeCommercialContext(baseInput({ category: "hotel chain" })).confidenceReason
    ).toMatch(/large or chain-scale hospitality category detected/i);
  });

  it("business segment never changes the technical score or improvementNeed — same findings, only category differs", () => {
    const findings = [
      finding({ category: "technical", severity: "important" }),
      finding({ category: "consistency", severity: "important" })
    ];
    const score = { score: 55, breakdown: [] };
    const smallIndependent = analyzeCommercialContext(
      baseInput({ category: "independent restaurant", score, findings })
    );
    const premiumIndependent = analyzeCommercialContext(
      baseInput({ category: "luxury independent riad", score, findings })
    );
    expect(smallIndependent.businessSegment).toBe("small_independent");
    expect(premiumIndependent.businessSegment).toBe("premium_independent");
    // Different segment, identical technical score and improvement need —
    // the segment adds context, it does not feed back into either.
    expect(smallIndependent.technical.technicalHealthScore).toBe(55);
    expect(premiumIndependent.technical.technicalHealthScore).toBe(55);
    expect(smallIndependent.salesDecision.improvementNeed).toBe(
      premiumIndependent.salesDecision.improvementNeed
    );
    expect(smallIndependent.recommendedService).toBe(premiumIndependent.recommendedService);
  });

  it("preserves existing high-fit categories unchanged (riad, boutique, family-owned, guesthouse)", () => {
    for (const category of ["riad", "boutique hotel", "family-owned restaurant", "guest house"])
      expect(
        analyzeCommercialContext(baseInput({ category })).opportunityLevel,
        `category "${category}" should still be high fit`
      ).toBe("high");
  });
});
