import { describe, expect, it } from "vitest";
import type { EvidenceRecord, FindingRecord } from "./audit-ledger";
import { compareReelFixOutcome } from "./reelfix-comparison";

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: overrides.id || "f-1",
    scanId: "scan-1",
    analysisRunId: null,
    kind: "issue",
    title: "x",
    category: "technical",
    severity: "important",
    priority: 2,
    summary: "x",
    evidenceIds: ["ev-1"],
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides
  };
}

// A deterministic, verified structural defect — the only kind of evidence
// that produces a stable cross-scan identity.
function deterministicEvidence(
  overrides: Partial<EvidenceRecord> = {}
): EvidenceRecord {
  return {
    id: "ev-1",
    scanId: "scan-1",
    sourceType: "html_static",
    sourceUrl: "https://example.com/",
    observationType: "forms",
    observation: "The email field has no visible or accessible label.",
    capturedAt: "2026-08-19T00:00:00.000Z",
    collector: "reelscan-v1@generic-website-checks",
    metadata: {
      severity: "important",
      verification: "verified",
      rootFindingKey: "forms:unlabeled-controls:form-1"
    },
    ...overrides
  };
}

// An AI content-quality judgment: cites only content evidence, which
// carries no deterministic identity — the exact Riad Kniza shape.
function aiOnlyEvidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "ev-1",
    scanId: "scan-1",
    sourceType: "html_static",
    sourceUrl: "https://example.com/",
    observationType: "hero_text_excerpt",
    observation: "Bienvenue chez nous.",
    capturedAt: "2026-08-19T00:00:00.000Z",
    collector: "reelscan-v1@content-evidence",
    metadata: { verification: "verified" },
    ...overrides
  };
}

function scanInput(
  scanId: string,
  score: number,
  findings: FindingRecord[],
  evidence: EvidenceRecord[]
) {
  return { scanId, score: { score, breakdown: [] }, findings, evidence };
}

describe("compareReelFixOutcome", () => {
  it("5. a resolved deterministic issue appears as resolved when it is absent from the verification scan", () => {
    const evidence = deterministicEvidence();
    const baselineFinding = finding({ evidenceIds: ["ev-1"] });

    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 60, [baselineFinding], [evidence]),
      verification: scanInput("verification", 90, [], [])
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.remaining).toHaveLength(0);
    expect(result.newIssues).toHaveLength(0);
  });

  it("6. an issue present in both scans (same stable evidence identity) appears as remaining", () => {
    const baselineEvidence = deterministicEvidence({ id: "ev-baseline" });
    const verificationEvidence = deterministicEvidence({ id: "ev-verification" });
    const baselineFinding = finding({ id: "f-baseline", evidenceIds: ["ev-baseline"] });
    const verificationFinding = finding({
      id: "f-verification",
      evidenceIds: ["ev-verification"],
      // Deliberately different AI wording for the same underlying evidence
      // identity — must still match, since matching is evidence-based.
      title: "Contact form still needs a label",
      summary: "The email field still has no visible or accessible label."
    });

    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 60, [baselineFinding], [baselineEvidence]),
      verification: scanInput(
        "verification",
        60,
        [verificationFinding],
        [verificationEvidence]
      )
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
    expect(result.newIssues).toHaveLength(0);
  });

  it("7. a genuinely new deterministic issue appears as new", () => {
    const verificationEvidence = deterministicEvidence({
      id: "ev-new",
      observationType: "accessibility",
      metadata: {
        severity: "important",
        verification: "verified",
        rootFindingKey: "accessibility:missing-alt:img-2"
      }
    });
    const verificationFinding = finding({
      evidenceIds: ["ev-new"],
      category: "technical"
    });

    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 60, [], []),
      verification: scanInput(
        "verification",
        55,
        [verificationFinding],
        [verificationEvidence]
      )
    });

    expect(result.newIssues).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.remaining).toHaveLength(0);
  });

  it("8. AI-only wording variation does NOT falsely produce a verified resolved issue", () => {
    const baselineEvidence = aiOnlyEvidence();
    const baselineFinding = finding({
      category: "positioning",
      severity: "critical",
      evidenceIds: ["ev-1"],
      summary: "The homepage does not clearly say what is offered."
    });

    // The AI simply doesn't repeat the same judgment on re-scan — a
    // realistic Riad Kniza-style wording disappearance, not a real fix.
    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 40, [baselineFinding], [baselineEvidence]),
      verification: scanInput("verification", 60, [], [])
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsReview[0].whatWeFound).toContain(
      "does not clearly say what is offered"
    );
  });

  it("AI-only findings appearing only in verification are never confidently reported as new either", () => {
    const verificationEvidence = aiOnlyEvidence();
    const verificationFinding = finding({
      category: "positioning",
      severity: "important",
      evidenceIds: ["ev-1"],
      summary: "The hero text could be clearer about the offer."
    });

    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 60, [], []),
      verification: scanInput(
        "verification",
        60,
        [verificationFinding],
        [verificationEvidence]
      )
    });

    expect(result.newIssues).toHaveLength(0);
    expect(result.needsReview).toHaveLength(1);
  });

  it("9. baseline and verification technical scores are preserved exactly, never recomputed", () => {
    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 57, [], []),
      verification: scanInput("verification", 84, [], [])
    });
    expect(result.technicalHealthScore).toEqual({ before: 57, after: 84 });
  });

  it("preserves null scores as null rather than substituting 0", () => {
    const result = compareReelFixOutcome({
      baseline: { scanId: "baseline", score: null, findings: [], evidence: [] },
      verification: { scanId: "verification", score: null, findings: [], evidence: [] }
    });
    expect(result.technicalHealthScore).toEqual({ before: null, after: null });
  });

  it("carries verification strengths through as plain customer-safe text", () => {
    const strength = finding({
      kind: "strength",
      severity: null,
      category: "trust",
      title: "Clear reviews",
      summary: "Customer reviews are prominently displayed."
    });
    const result = compareReelFixOutcome({
      baseline: scanInput("baseline", 60, [], []),
      verification: scanInput("verification", 90, [strength], [])
    });
    expect(result.strengths).toEqual(["Customer reviews are prominently displayed."]);
  });

  it("never leaks evidenceIds, collector, analysisRunId, severity, confidence, or scoreImpact in any bucket", () => {
    const detEvidence = deterministicEvidence();
    const aiEvidence = aiOnlyEvidence({ id: "ev-ai" });
    const resolvedSource = finding({
      id: "f-resolved",
      evidenceIds: ["ev-1"],
      analysisRunId: "run-secret",
      confidence: "High",
      scoreImpact: -10
    });
    const needsReviewSource = finding({
      id: "f-needs-review",
      evidenceIds: ["ev-ai"],
      category: "positioning",
      severity: "critical"
    });

    const result = compareReelFixOutcome({
      baseline: scanInput(
        "baseline",
        50,
        [resolvedSource, needsReviewSource],
        [detEvidence, aiEvidence]
      ),
      verification: scanInput("verification", 80, [], [])
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("evidenceIds");
    expect(serialized).not.toContain("ev-1");
    expect(serialized).not.toContain("ev-ai");
    expect(serialized).not.toContain("run-secret");
    expect(serialized).not.toContain("collector");
    expect(serialized).not.toContain("analysisRunId");
    expect(serialized).not.toContain("scoreImpact");
    expect(serialized).not.toContain("confidence");
    expect(serialized).not.toContain("rootFindingKey");
  });
});
