import { describe, expect, it } from "vitest";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import { PUBLIC_INTAKE_RETENTION_DAYS } from "./public-intake-config";
import {
  InMemoryPublicIntakeStore,
  type InboundRequestRecord
} from "./public-intake-store";
import {
  InMemoryRetentionStatusStore,
  PublicIntakeRetentionService,
  computeRetentionCutoffIso,
  ensureRetentionCleanupSchedule,
  isRequestExpired
} from "./public-intake-retention";

const NOW = "2026-08-17T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number, from = NOW): string {
  return new Date(Date.parse(from) - days * DAY_MS).toISOString();
}

function record(overrides: Partial<InboundRequestRecord> = {}): InboundRequestRecord {
  return {
    id: "req-1",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    name: "Amina",
    businessName: "Le Petit Café",
    city: "Casablanca",
    supportNeed: "reelscan",
    email: "amina@example.com",
    linkKind: "website",
    submittedLink: "https://lepetitcafe.example/",
    scanTargetKey: "lepetitcafe.example",
    scanReuseKey: "https://lepetitcafe.example/",
    language: "fr",
    requestStatus: "scan_ready_needs_review",
    privacyAcceptedAt: daysAgo(1),
    ...overrides
  };
}

function harness() {
  const store = new InMemoryPublicIntakeStore();
  const auditLedger = new AuditLedgerService(new InMemoryAuditLedgerStore());
  const statusStore = new InMemoryRetentionStatusStore();
  const service = new PublicIntakeRetentionService({ store, auditLedger, statusStore });
  return { store, auditLedger, statusStore, service };
}

function seedScanTrail(auditLedger: AuditLedgerService, scanId: string) {
  const evidence = auditLedger.recordEvidence({
    scanId,
    sourceType: "html_static",
    sourceUrl: "https://lepetitcafe.example/",
    observationType: "reservation_cta",
    observation: "No reservation call-to-action found above the fold.",
    capturedAt: NOW,
    collector: "browser-analysis@html-fallback"
  });
  const run = auditLedger.startAiAnalysisRun({
    scanId,
    provider: "cloudflare-workers-ai",
    model: "@cf/meta/llama-3.2-1b-instruct",
    promptVersion: "reelscan-v1",
    schemaVersion: "reelscan-findings-v1",
    evidenceIds: [evidence.id]
  });
  auditLedger.completeAiAnalysisRun(run.id, { status: "completed" });
  const finding = auditLedger.recordFinding({
    scanId,
    analysisRunId: run.id,
    kind: "issue",
    title: "No reservation CTA",
    category: "guest_decision",
    severity: "important",
    priority: 2,
    summary: "x",
    evidenceIds: [evidence.id]
  });
  const review = auditLedger.recordReviewEvent({
    findingId: finding.id,
    action: "accepted",
    reviewer: "reviewer@reelhaus.de"
  });
  return { evidence, run, finding, review };
}

function trailIsEmpty(auditLedger: AuditLedgerService, scanId: string): boolean {
  const trail = auditLedger.getScanAuditTrail(scanId);
  return (
    trail.evidence.length === 0 &&
    trail.analysisRuns.length === 0 &&
    trail.findings.length === 0 &&
    trail.reviewEvents.length === 0
  );
}

describe("PUBLIC_INTAKE_RETENTION_DAYS", () => {
  it("is exactly 90 (owner decision)", () => {
    expect(PUBLIC_INTAKE_RETENTION_DAYS).toBe(90);
  });
});

describe("cutoff arithmetic — exact, not approximate month logic", () => {
  it("computes the cutoff as exactly RETENTION_DAYS*24h before now", () => {
    const cutoff = computeRetentionCutoffIso(NOW);
    expect(Date.parse(NOW) - Date.parse(cutoff)).toBe(
      PUBLIC_INTAKE_RETENTION_DAYS * DAY_MS
    );
  });

  // 1. an 89-day-old request remains
  it("a request 89 days old is NOT expired", () => {
    expect(isRequestExpired(daysAgo(89), NOW)).toBe(false);
  });

  // 2. exactly-at-cutoff semantics are deterministic
  it("a request exactly 90 days old (to the millisecond) IS expired — inclusive boundary, deterministic", () => {
    const exactlyAtCutoff = computeRetentionCutoffIso(NOW);
    expect(isRequestExpired(exactlyAtCutoff, NOW)).toBe(true);
    // One millisecond younger than the cutoff must NOT be expired — proves
    // this is a real boundary, not a coarse day-level comparison.
    const oneMsYounger = new Date(Date.parse(exactlyAtCutoff) + 1).toISOString();
    expect(isRequestExpired(oneMsYounger, NOW)).toBe(false);
  });

  // 3. a >90-day-old request is deleted (expired)
  it("a request 91 days old IS expired", () => {
    expect(isRequestExpired(daysAgo(91), NOW)).toBe(true);
  });

  // 4. updated_at never extends retention
  it("isRequestExpired takes createdAt only — there is no updatedAt parameter to accidentally use", () => {
    // Structural proof: the function signature itself has no updatedAt
    // input, so a request touched yesterday but created 91 days ago is
    // still expired — internal work cannot silently extend retention.
    expect(isRequestExpired.length).toBe(2); // (createdAtIso, nowIso)
    expect(isRequestExpired(daysAgo(91), NOW)).toBe(true);
  });
});

describe("PublicIntakeRetentionService.cleanup — deletion", () => {
  it("deletes a >90-day-old request and every personal field on it", () => {
    const { store, service } = harness();
    store.insertRequest(record({ id: "expired", createdAt: daysAgo(91), scanId: undefined }));
    const result = service.cleanup(NOW, 50);
    expect(result.deletedRequests).toBe(1);
    expect(store.getRequest("expired")).toBeNull();
  });

  it("leaves an 89-day-old request completely untouched", () => {
    const { store, service } = harness();
    store.insertRequest(record({ id: "fresh", createdAt: daysAgo(89) }));
    const result = service.cleanup(NOW, 50);
    expect(result.deletedRequests).toBe(0);
    expect(store.getRequest("fresh")).not.toBeNull();
  });

  // 5. no-link expired request deleted
  it("deletes an expired no-link request", () => {
    const { store, service } = harness();
    store.insertRequest(
      record({
        id: "no-link",
        createdAt: daysAgo(95),
        linkKind: "none",
        submittedLink: undefined,
        scanTargetKey: undefined,
        scanReuseKey: undefined,
        scanId: undefined,
        requestStatus: "needs_target_review"
      })
    );
    service.cleanup(NOW, 50);
    expect(store.getRequest("no-link")).toBeNull();
  });

  // 6. needs_target_review expired request deleted
  it("deletes an expired needs_target_review request", () => {
    const { store, service } = harness();
    store.insertRequest(
      record({ id: "review", createdAt: daysAgo(120), requestStatus: "needs_target_review", scanId: undefined })
    );
    service.cleanup(NOW, 50);
    expect(store.getRequest("review")).toBeNull();
  });

  // 7. analysis_failed expired request deleted
  it("deletes an expired analysis_failed request", () => {
    const { store, service } = harness();
    store.insertRequest(
      record({
        id: "failed",
        createdAt: daysAgo(100),
        requestStatus: "analysis_failed",
        analysisErrorCode: "target_unreachable",
        scanFailedAt: daysAgo(99),
        scanId: undefined
      })
    );
    service.cleanup(NOW, 50);
    expect(store.getRequest("failed")).toBeNull();
  });

  // 8. stuck queued/scanning expired request deleted — an old broken/stuck
  // request must not become immortal just because it never reached a
  // "normal" terminal status.
  it("deletes an expired row stuck in queued_for_scan", () => {
    const { store, service } = harness();
    store.insertRequest(
      record({ id: "stuck-queued", createdAt: daysAgo(365), requestStatus: "queued_for_scan", scanId: undefined })
    );
    service.cleanup(NOW, 50);
    expect(store.getRequest("stuck-queued")).toBeNull();
  });

  it("deletes an expired row stuck in scanning", () => {
    const { store, service } = harness();
    store.insertRequest(
      record({ id: "stuck-scanning", createdAt: daysAgo(365), requestStatus: "scanning", scanId: undefined })
    );
    service.cleanup(NOW, 50);
    expect(store.getRequest("stuck-scanning")).toBeNull();
  });
});

describe("PublicIntakeRetentionService.cleanup — scan-audit reference safety", () => {
  // 9. expired request with a unique (non-reused) scan deletes the trail
  it("deletes the scan audit trail when the expired request was its only reference", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-unique");
    store.insertRequest(record({ id: "solo", createdAt: daysAgo(91), scanId: "scan-unique" }));
    const result = service.cleanup(NOW, 50);
    expect(result.deletedScanTrails).toBe(1);
    expect(trailIsEmpty(auditLedger, "scan-unique")).toBe(true);
  });

  // 10. review events deleted before/with the finding trail — no orphans
  it("leaves no orphaned review event once the scan trail is deleted", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-unique");
    store.insertRequest(record({ id: "solo", createdAt: daysAgo(91), scanId: "scan-unique" }));
    service.cleanup(NOW, 50);
    expect(auditLedger.getScanAuditTrail("scan-unique").reviewEvents).toEqual([]);
  });

  // 11 & 12. reused-scan regression, exactly as specified in the task:
  //   Request A created 91 days ago, scanId X
  //   Request B created 10 days ago,  scanId X
  //   cleanup: delete A, keep B, keep scan X's audit trail.
  //   Later, after B itself expires: delete B, delete scan X's audit trail.
  it("reused scan: deletes the expired referencing request but keeps the scan trail while another request still references it", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-x");
    store.insertRequest(record({ id: "A", createdAt: daysAgo(91), scanId: "scan-x" }));
    store.insertRequest(record({ id: "B", createdAt: daysAgo(10), scanId: "scan-x" }));

    const result = service.cleanup(NOW, 50);

    expect(store.getRequest("A")).toBeNull(); // delete A
    expect(store.getRequest("B")).not.toBeNull(); // keep B
    expect(result.deletedScanTrails).toBe(0);
    expect(trailIsEmpty(auditLedger, "scan-x")).toBe(false); // keep scan X's trail
  });

  it("reused scan: once the LAST referencing request also expires, the scan trail is finally deleted", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-x");
    store.insertRequest(record({ id: "A", createdAt: daysAgo(91), scanId: "scan-x" }));
    store.insertRequest(record({ id: "B", createdAt: daysAgo(10), scanId: "scan-x" }));
    service.cleanup(NOW, 50); // round 1: delete A, keep B + trail

    // Time passes — B is now also expired (e.g. 92 days later).
    const later = new Date(Date.parse(NOW) + 92 * DAY_MS).toISOString();
    const result = service.cleanup(later, 50);

    expect(store.getRequest("B")).toBeNull(); // delete B
    expect(result.deletedScanTrails).toBe(1);
    expect(trailIsEmpty(auditLedger, "scan-x")).toBe(true); // NOW delete scan X's trail
  });

  it("reused scan: both expired requests in the SAME batch still only delete the trail once, after the last one", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-x");
    store.insertRequest(record({ id: "A", createdAt: daysAgo(200), scanId: "scan-x" }));
    store.insertRequest(record({ id: "B", createdAt: daysAgo(150), scanId: "scan-x" }));

    const result = service.cleanup(NOW, 50);

    expect(store.getRequest("A")).toBeNull();
    expect(store.getRequest("B")).toBeNull();
    expect(result.deletedRequests).toBe(2);
    expect(result.deletedScanTrails).toBe(1); // exactly once, not twice
    expect(trailIsEmpty(auditLedger, "scan-x")).toBe(true);
  });

  // 13. Client #0 / unrelated audit trail cannot be deleted
  it("never touches a scan trail that no inbound_requests row ever referenced (e.g. Client #0)", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "client-zero-scan");
    store.insertRequest(record({ id: "unrelated", createdAt: daysAgo(91), scanId: "some-other-scan" }));
    service.cleanup(NOW, 50);
    expect(trailIsEmpty(auditLedger, "client-zero-scan")).toBe(false);
  });

  it("never touches an unrelated scan trail belonging to a request that is NOT yet expired", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-still-active");
    store.insertRequest(record({ id: "active", createdAt: daysAgo(5), scanId: "scan-still-active" }));
    service.cleanup(NOW, 50);
    expect(store.getRequest("active")).not.toBeNull();
    expect(trailIsEmpty(auditLedger, "scan-still-active")).toBe(false);
  });
});

describe("PublicIntakeRetentionService.cleanup — idempotency, batching, observability", () => {
  // 14. cleanup rerun is idempotent
  it("running cleanup twice in a row against the same now is safe — the second run finds nothing new", () => {
    const { store, auditLedger, service } = harness();
    seedScanTrail(auditLedger, "scan-x");
    store.insertRequest(record({ id: "expired", createdAt: daysAgo(91), scanId: "scan-x" }));

    const first = service.cleanup(NOW, 50);
    expect(first.deletedRequests).toBe(1);
    expect(first.deletedScanTrails).toBe(1);

    const second = service.cleanup(NOW, 50);
    expect(second.deletedRequests).toBe(0);
    expect(second.deletedScanTrails).toBe(0);
  });

  // 15. cleanup batching works
  it("respects the batch limit, leaving the rest for a follow-up pass", () => {
    const { store, service } = harness();
    for (let i = 0; i < 5; i++)
      store.insertRequest(record({ id: `r${i}`, createdAt: daysAgo(100), scanId: undefined }));

    const first = service.cleanup(NOW, 2);
    expect(first.deletedRequests).toBe(2);
    expect(first.moreRemaining).toBe(true);

    const second = service.cleanup(NOW, 2);
    expect(second.deletedRequests).toBe(2);
    expect(second.moreRemaining).toBe(true);

    const third = service.cleanup(NOW, 2);
    expect(third.deletedRequests).toBe(1);
    expect(third.moreRemaining).toBe(false);

    expect(store.listRequests(10)).toHaveLength(0);
  });

  it("records only aggregate cleanup metadata — no personal fields in the status snapshot", () => {
    const { store, statusStore, service } = harness();
    store.insertRequest(record({ id: "expired", createdAt: daysAgo(91), scanId: undefined }));
    service.cleanup(NOW, 50);
    const status = statusStore.getStatus();
    expect(status).toEqual({
      lastCleanupAt: NOW,
      lastDeletedRequests: 1,
      lastDeletedScanTrails: 0
    });
    // Structural proof there is no room for personal data: exactly these
    // three aggregate keys, nothing else.
    expect(Object.keys(status).sort()).toEqual(
      ["lastCleanupAt", "lastDeletedRequests", "lastDeletedScanTrails"].sort()
    );
  });

  // 17. cleanup causes zero AI calls / external fetches
  it("makes zero network calls of any kind — cleanup is pure storage deletion", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("retention cleanup must never fetch");
    }) as typeof fetch;
    try {
      const { store, auditLedger, service } = harness();
      seedScanTrail(auditLedger, "scan-x");
      store.insertRequest(record({ id: "expired", createdAt: daysAgo(91), scanId: "scan-x" }));
      expect(() => service.cleanup(NOW, 50)).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);
  });
});

describe("ensureRetentionCleanupSchedule — daily schedule setup", () => {
  // A minimal fake mirroring the agents SDK's own documented cron dedup
  // contract (idempotent by callback+cron+payload) — this test proves OUR
  // calling code passes the right arguments (cron string, exact callback
  // name, idempotent:true) on every call, which is what onStart() running
  // on every Durable Object wake actually depends on. The SDK's own dedup
  // guarantee is documented (agents v0.17.4) and is not re-verified here.
  function fakeIdempotentScheduler() {
    const calls: Array<{ when: string; callback: string; options: unknown }> = [];
    const existing = new Map<string, string>();
    let nextId = 0;
    const schedule = async (
      when: string,
      callback: "runInboundRetentionCleanup",
      payload: undefined,
      options: { idempotent: true }
    ) => {
      calls.push({ when, callback, options });
      const key = `${when}|${callback}|${JSON.stringify(payload)}`;
      if (options.idempotent && existing.has(key)) return { id: existing.get(key) };
      const id = `sched-${nextId++}`;
      existing.set(key, id);
      return { id };
    };
    return { schedule, calls };
  }

  // 16. daily schedule setup is idempotent
  it("calling it repeatedly (simulating repeated Durable Object wakes) never creates a duplicate schedule", async () => {
    const { schedule, calls } = fakeIdempotentScheduler();
    await ensureRetentionCleanupSchedule(schedule);
    await ensureRetentionCleanupSchedule(schedule);
    await ensureRetentionCleanupSchedule(schedule);

    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.callback === "runInboundRetentionCleanup")).toBe(true);
    expect(calls.every((c) => (c.options as { idempotent: boolean }).idempotent === true)).toBe(true);
    // Every call used the exact same cron string — a different string would
    // be treated as a DIFFERENT schedule by the SDK's own dedup key.
    expect(new Set(calls.map((c) => c.when)).size).toBe(1);
  });
});
