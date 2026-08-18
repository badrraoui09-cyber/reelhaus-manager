import { describe, expect, it } from "vitest";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import {
  InMemoryReelFixVerificationStore,
  ReelFixVerificationError,
  ReelFixVerificationService
} from "./reelfix-verification";

function buildLedger() {
  return new AuditLedgerService(new InMemoryAuditLedgerStore());
}

/**
 * Simulates a completed ReelScan at the audit-ledger layer, without going
 * through the full reelscan.ts pipeline (no AI mocking needed): records
 * one evidence item for the given target URL, starts and completes an
 * analysis run, and — unless `withoutFinding` — records one finding
 * citing that evidence, so isScanCompleted()/getScanAuditTrail() see
 * exactly what a real completed scan would leave behind.
 */
function seedCompletedScan(
  auditLedger: AuditLedgerService,
  scanId: string,
  targetUrl: string
): void {
  const evidence = auditLedger.recordEvidence({
    scanId,
    sourceType: "html_static",
    sourceUrl: targetUrl,
    observationType: "page_title",
    observation: "The <title> element reads: \"Le Petit Café\".",
    capturedAt: "2026-08-19T09:00:00.000Z",
    collector: "reelscan-v1@content-evidence",
    metadata: { verification: "verified" }
  });
  const run = auditLedger.startAiAnalysisRun({
    scanId,
    provider: "cloudflare-workers-ai",
    model: "test-model",
    promptVersion: "v1",
    schemaVersion: "v1",
    evidenceIds: [evidence.id]
  });
  auditLedger.recordFinding({
    scanId,
    analysisRunId: run.id,
    kind: "strength",
    title: "Clear identity",
    category: "positioning",
    severity: null,
    impact: "high",
    priority: 1,
    summary: "The business name is clear.",
    evidenceIds: [evidence.id],
    confidence: "High"
  });
  auditLedger.completeAiAnalysisRun(run.id, { status: "completed" });
}

function seedFailedScan(
  auditLedger: AuditLedgerService,
  scanId: string,
  targetUrl: string
): void {
  const evidence = auditLedger.recordEvidence({
    scanId,
    sourceType: "html_static",
    sourceUrl: targetUrl,
    observationType: "page_title",
    observation: "x",
    capturedAt: "2026-08-19T09:00:00.000Z",
    collector: "reelscan-v1@content-evidence",
    metadata: { verification: "verified" }
  });
  const run = auditLedger.startAiAnalysisRun({
    scanId,
    provider: "cloudflare-workers-ai",
    model: "test-model",
    promptVersion: "v1",
    schemaVersion: "v1",
    evidenceIds: [evidence.id]
  });
  auditLedger.completeAiAnalysisRun(run.id, {
    status: "failed",
    error: "AI call failed"
  });
}

describe("ReelFixVerificationService.linkVerification", () => {
  it("1. links a completed baseline to a completed verification of the same target", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-baseline", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    const link = service.linkVerification({
      baselineScanId: "scan-baseline",
      verificationScanId: "scan-verification"
    });

    expect(link.baselineScanId).toBe("scan-baseline");
    expect(link.verificationScanId).toBe("scan-verification");
    expect(link.id).toBeTruthy();
    expect(link.createdAt).toBeTruthy();
    expect(service.latestVerification("scan-baseline")?.id).toBe(link.id);
  });

  it("2. rejects a scan verifying itself", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-a", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-a",
        verificationScanId: "scan-a"
      })
    ).toThrow(ReelFixVerificationError);
    try {
      service.linkVerification({
        baselineScanId: "scan-a",
        verificationScanId: "scan-a"
      });
    } catch (error) {
      expect((error as ReelFixVerificationError).reason).toBe(
        "scan_cannot_verify_itself"
      );
    }
  });

  it("3. rejects an incompatible/different target URL", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-baseline", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification", "https://different-site.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-baseline",
        verificationScanId: "scan-verification"
      })
    ).toThrow(ReelFixVerificationError);
    try {
      service.linkVerification({
        baselineScanId: "scan-baseline",
        verificationScanId: "scan-verification"
      });
    } catch (error) {
      expect((error as ReelFixVerificationError).reason).toBe("target_mismatch");
    }
  });

  it("4. rejects an incomplete (failed or nonexistent) scan as the verification", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-baseline", "https://lepetitcafe.example/");
    seedFailedScan(auditLedger, "scan-verification-failed", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-baseline",
        verificationScanId: "scan-verification-failed"
      })
    ).toThrow(ReelFixVerificationError);

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-baseline",
        verificationScanId: "scan-does-not-exist"
      })
    ).toThrow(ReelFixVerificationError);
  });

  it("also rejects an incomplete scan as the baseline", () => {
    const auditLedger = buildLedger();
    seedFailedScan(auditLedger, "scan-baseline-failed", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-baseline-failed",
        verificationScanId: "scan-verification"
      })
    ).toThrow(ReelFixVerificationError);
  });

  it("does not silently overwrite the original baseline: a baseline can have more than one verification", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-baseline", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification-1", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification-2", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    service.linkVerification({
      baselineScanId: "scan-baseline",
      verificationScanId: "scan-verification-1"
    });
    service.linkVerification({
      baselineScanId: "scan-baseline",
      verificationScanId: "scan-verification-2"
    });

    const links = service.listVerifications("scan-baseline");
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.verificationScanId)).toEqual([
      "scan-verification-1",
      "scan-verification-2"
    ]);
    // The baseline itself is never mutated or removed by linking.
    expect(auditLedger.getScanAuditTrail("scan-baseline").findings).toHaveLength(1);
  });

  it("rejects linking the same verification scan to more than one baseline (unambiguous identity)", () => {
    const auditLedger = buildLedger();
    seedCompletedScan(auditLedger, "scan-baseline-1", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-baseline-2", "https://lepetitcafe.example/");
    seedCompletedScan(auditLedger, "scan-verification", "https://lepetitcafe.example/");
    const service = new ReelFixVerificationService(
      auditLedger,
      new InMemoryReelFixVerificationStore()
    );

    service.linkVerification({
      baselineScanId: "scan-baseline-1",
      verificationScanId: "scan-verification"
    });

    expect(() =>
      service.linkVerification({
        baselineScanId: "scan-baseline-2",
        verificationScanId: "scan-verification"
      })
    ).toThrow(ReelFixVerificationError);
  });
});
