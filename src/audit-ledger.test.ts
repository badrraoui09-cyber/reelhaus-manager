import { describe, expect, it } from "vitest";
import {
  AuditLedgerError,
  AuditLedgerService,
  InMemoryAuditLedgerStore,
  type EvidenceRecord
} from "./audit-ledger";

function service() {
  return new AuditLedgerService(new InMemoryAuditLedgerStore());
}

function evidenceInput(
  overrides: Partial<Omit<EvidenceRecord, "id">> = {}
): Omit<EvidenceRecord, "id"> {
  return {
    scanId: "scan-1",
    sourceType: "html_static",
    sourceUrl: "https://example.ma/",
    observationType: "reservation_cta",
    observation: "No reservation call-to-action found above the fold.",
    capturedAt: "2026-08-17T10:00:00.000Z",
    collector: "browser-analysis@html-fallback",
    ...overrides
  };
}

describe("evidence", () => {
  it("stores evidence and returns it unchanged on retrieval", () => {
    const ledger = service();
    const record = ledger.recordEvidence(evidenceInput());
    expect(record.id).toBeTruthy();
    expect(ledger.getScanAuditTrail("scan-1").evidence).toEqual([record]);
  });

  it("auto-generates a unique ID per record", () => {
    const ledger = service();
    const first = ledger.recordEvidence(evidenceInput());
    const second = ledger.recordEvidence(evidenceInput());
    expect(first.id).not.toBe(second.id);
  });

  it("keeps a caller-supplied ID stable instead of overwriting it", () => {
    const ledger = service();
    const record = ledger.recordEvidence({
      ...evidenceInput(),
      id: "evidence-fixed-id"
    });
    expect(record.id).toBe("evidence-fixed-id");
    expect(ledger.getScanAuditTrail("scan-1").evidence[0].id).toBe(
      "evidence-fixed-id"
    );
  });
});

describe("AI analysis runs", () => {
  it("starts and completes a run", async () => {
    const ledger = service();
    const evidence = ledger.recordEvidence(evidenceInput());
    const run = ledger.startAiAnalysisRun({
      scanId: "scan-1",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: [evidence.id]
    });
    expect(run.status).toBe("running");
    expect(run.evidenceIds).toEqual([evidence.id]);

    const completed = ledger.completeAiAnalysisRun(run.id, {
      status: "completed"
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
  });

  it("records a failure reason when a run fails", () => {
    const ledger = service();
    const run = ledger.startAiAnalysisRun({
      scanId: "scan-1",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: []
    });
    const failed = ledger.completeAiAnalysisRun(run.id, {
      status: "failed",
      error: "model timeout"
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("model timeout");
  });

  it("rejects a run that cites evidence from another scan", () => {
    const ledger = service();
    const foreignEvidence = ledger.recordEvidence(
      evidenceInput({ scanId: "scan-2" })
    );
    expect(() =>
      ledger.startAiAnalysisRun({
        scanId: "scan-1",
        provider: "cloudflare-workers-ai",
        model: "@cf/meta/llama-3.2-1b-instruct",
        promptVersion: "reelscan-v1",
        schemaVersion: "reelscan-findings-v1",
        evidenceIds: [foreignEvidence.id]
      })
    ).toThrow(AuditLedgerError);
  });

  it("rejects completing a run that does not exist", () => {
    const ledger = service();
    expect(() =>
      ledger.completeAiAnalysisRun("missing-run", { status: "completed" })
    ).toThrow(AuditLedgerError);
  });
});

describe("findings", () => {
  it("accepts a rule-based finding with valid evidence", () => {
    const ledger = service();
    const evidence = ledger.recordEvidence(evidenceInput());
    const finding = ledger.recordFinding({
      scanId: "scan-1",
      analysisRunId: null,
      kind: "issue",
      title: "No reservation CTA",
      category: "guest_decision",
      severity: "important",
      priority: 2,
      summary: "Homepage has no obvious reservation CTA above the fold.",
      evidenceIds: [evidence.id]
    });
    expect(finding.id).toBeTruthy();
    expect(finding.evidenceIds).toEqual([evidence.id]);
  });

  it("rejects a finding with no evidence", () => {
    const ledger = service();
    expect(() =>
      ledger.recordFinding({
        scanId: "scan-1",
        analysisRunId: null,
        kind: "issue",
        title: "No reservation CTA",
        category: "guest_decision",
        severity: "important",
        priority: 2,
        summary: "x",
        evidenceIds: []
      })
    ).toThrow(AuditLedgerError);
  });

  it("rejects a finding referencing unknown evidence", () => {
    const ledger = service();
    expect(() =>
      ledger.recordFinding({
        scanId: "scan-1",
        analysisRunId: null,
        kind: "issue",
        title: "No reservation CTA",
        category: "guest_decision",
        severity: "important",
        priority: 2,
        summary: "x",
        evidenceIds: ["does-not-exist"]
      })
    ).toThrow(AuditLedgerError);
  });

  it("rejects a finding referencing evidence from another scan", () => {
    const ledger = service();
    const foreignEvidence = ledger.recordEvidence(
      evidenceInput({ scanId: "scan-2" })
    );
    expect(() =>
      ledger.recordFinding({
        scanId: "scan-1",
        analysisRunId: null,
        kind: "issue",
        title: "No reservation CTA",
        category: "guest_decision",
        severity: "important",
        priority: 2,
        summary: "x",
        evidenceIds: [foreignEvidence.id]
      })
    ).toThrow(AuditLedgerError);
  });

  it("accepts an AI finding that only cites evidence included in its analysis run", () => {
    const ledger = service();
    const evidence = ledger.recordEvidence(evidenceInput());
    const run = ledger.startAiAnalysisRun({
      scanId: "scan-1",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: [evidence.id]
    });
    const finding = ledger.recordFinding({
      scanId: "scan-1",
      analysisRunId: run.id,
      kind: "issue",
      title: "No reservation CTA",
      category: "guest_decision",
      severity: "important",
      priority: 2,
      summary: "x",
      evidenceIds: [evidence.id]
    });
    expect(finding.analysisRunId).toBe(run.id);
  });

  it("rejects an AI finding that cites evidence outside its analysis run", () => {
    const ledger = service();
    const includedEvidence = ledger.recordEvidence(evidenceInput());
    const excludedEvidence = ledger.recordEvidence(
      evidenceInput({ observationType: "menu_link_status" })
    );
    const run = ledger.startAiAnalysisRun({
      scanId: "scan-1",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: [includedEvidence.id]
    });
    expect(() =>
      ledger.recordFinding({
        scanId: "scan-1",
        analysisRunId: run.id,
        kind: "issue",
        title: "Menu link broken",
        category: "guest_decision",
        severity: "important",
        priority: 2,
        summary: "x",
        evidenceIds: [excludedEvidence.id]
      })
    ).toThrow(AuditLedgerError);
  });

  it("rejects an AI finding whose analysis run belongs to a different scan", () => {
    const ledger = service();
    const evidenceScan1 = ledger.recordEvidence(evidenceInput());
    const evidenceScan2 = ledger.recordEvidence(
      evidenceInput({ scanId: "scan-2" })
    );
    const runOnScan2 = ledger.startAiAnalysisRun({
      scanId: "scan-2",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: [evidenceScan2.id]
    });
    expect(() =>
      ledger.recordFinding({
        scanId: "scan-1",
        analysisRunId: runOnScan2.id,
        kind: "issue",
        title: "Cross-scan finding",
        category: "guest_decision",
        severity: "important",
        priority: 2,
        summary: "x",
        evidenceIds: [evidenceScan1.id]
      })
    ).toThrow(AuditLedgerError);
  });
});

describe("review events", () => {
  it("accepts a valid review event", () => {
    const ledger = service();
    const evidence = ledger.recordEvidence(evidenceInput());
    const finding = ledger.recordFinding({
      scanId: "scan-1",
      analysisRunId: null,
      kind: "issue",
      title: "No reservation CTA",
      category: "guest_decision",
      severity: "important",
      priority: 2,
      summary: "x",
      evidenceIds: [evidence.id]
    });
    const event = ledger.recordReviewEvent({
      findingId: finding.id,
      action: "severity_changed",
      previousValue: { severity: "important" },
      newValue: { severity: "critical" },
      reason: "Reservation CTA affects revenue directly.",
      reviewer: "reviewer@reelhaus.de"
    });
    expect(event.id).toBeTruthy();
    expect(event.createdAt).toBeTruthy();
  });

  it("rejects a review event for an unknown finding", () => {
    const ledger = service();
    expect(() =>
      ledger.recordReviewEvent({
        findingId: "does-not-exist",
        action: "accepted",
        reviewer: "reviewer@reelhaus.de"
      })
    ).toThrow(AuditLedgerError);
  });
});

describe("scan audit trail", () => {
  it("reconstructs the full lineage for a scan", () => {
    const ledger = service();
    const evidence = ledger.recordEvidence(evidenceInput());
    const run = ledger.startAiAnalysisRun({
      scanId: "scan-1",
      provider: "cloudflare-workers-ai",
      model: "@cf/meta/llama-3.2-1b-instruct",
      promptVersion: "reelscan-v1",
      schemaVersion: "reelscan-findings-v1",
      evidenceIds: [evidence.id]
    });
    ledger.completeAiAnalysisRun(run.id, { status: "completed" });
    const finding = ledger.recordFinding({
      scanId: "scan-1",
      analysisRunId: run.id,
      kind: "issue",
      title: "No reservation CTA",
      category: "guest_decision",
      severity: "important",
      priority: 2,
      summary: "x",
      evidenceIds: [evidence.id]
    });
    const review = ledger.recordReviewEvent({
      findingId: finding.id,
      action: "accepted",
      reviewer: "reviewer@reelhaus.de"
    });

    const trail = ledger.getScanAuditTrail("scan-1");
    expect(trail.scanId).toBe("scan-1");
    expect(trail.evidence).toEqual([evidence]);
    expect(trail.analysisRuns.map((r) => r.id)).toEqual([run.id]);
    expect(trail.findings).toEqual([finding]);
    expect(trail.reviewEvents).toEqual([review]);
  });

  it("does not leak evidence, findings, or reviews from other scans", () => {
    const ledger = service();
    const evidenceScan1 = ledger.recordEvidence(evidenceInput());
    ledger.recordEvidence(evidenceInput({ scanId: "scan-2" }));
    ledger.recordFinding({
      scanId: "scan-1",
      analysisRunId: null,
      kind: "issue",
      title: "x",
      category: "guest_decision",
      severity: "optional",
      priority: 1,
      summary: "x",
      evidenceIds: [evidenceScan1.id]
    });

    const trail = ledger.getScanAuditTrail("scan-2");
    expect(trail.evidence).toHaveLength(1);
    expect(trail.findings).toHaveLength(0);
  });
});
