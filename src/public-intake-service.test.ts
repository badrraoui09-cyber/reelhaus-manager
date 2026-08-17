import { describe, expect, it } from "vitest";
import type { WorkersAiBinding } from "./ai-service";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import {
  PublicIntakeService,
  listInboundRequestsForManager,
  normalizeScanTargetKey,
  type PublicIntakeDeps
} from "./public-intake-service";
import { InMemoryPublicIntakeStore } from "./public-intake-store";
import type { PublicReelScanRequest } from "./public-request-schema";

function fakeAi(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

function baseRequest(
  overrides: Partial<PublicReelScanRequest> = {}
): PublicReelScanRequest {
  return {
    name: "Amina",
    businessName: "Le Petit Café",
    city: "Casablanca",
    supportNeed: "reelscan",
    email: "amina@example.com",
    privacyAccepted: true,
    language: "fr",
    turnstileToken: "token-123",
    ...overrides
  };
}

function websiteFetcher(html: string): typeof fetch {
  return (async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch;
}

const SAFE_HTML = `<!DOCTYPE html><html lang="fr"><head><title>Le Petit Café</title></head><body><h1>Le Petit Café</h1></body></html>`;

function successfulAi(): WorkersAiBinding {
  return fakeAi(async () => ({ response: JSON.stringify({ findings: [] }) }));
}

function noopSchedule(): Promise<void> {
  return Promise.resolve();
}

function buildService(overrides: Partial<PublicIntakeDeps> = {}) {
  const store = overrides.store ?? new InMemoryPublicIntakeStore();
  const auditLedger = overrides.auditLedger ?? new AuditLedgerService(new InMemoryAuditLedgerStore());
  const service = new PublicIntakeService({
    store,
    auditLedger,
    ai: successfulAi(),
    fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    scheduleQueueProcessing: noopSchedule,
    ...overrides
  });
  return { service, store, auditLedger };
}

describe("PublicIntakeService.submit — link handling", () => {
  it("accepts a request with no link and marks it needs_target_review, without attempting a scan", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(baseRequest(), "caller-1", null);
    expect(outcome.accepted).toBe(true);
    expect(fetchCalled).toBe(false);
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.requestStatus).toBe("needs_target_review");
    expect(stored.linkKind).toBe("none");
  });

  it("stores an Instagram link as context but never fetches it", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://instagram.com/lepetitcafe" }),
      "caller-1",
      null
    );
    expect(fetchCalled).toBe(false);
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.linkKind).toBe("instagram");
    expect(stored.submittedLink).toBe("https://instagram.com/lepetitcafe");
    expect(stored.requestStatus).toBe("needs_target_review");
  });

  it("stores a Google Maps link as context but never fetches it", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://maps.app.goo.gl/xyz" }),
      "caller-1",
      null
    );
    expect(fetchCalled).toBe(false);
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.linkKind).toBe("google_maps");
  });

  it("queues a normal safe website for scanning, without blocking the request on the scan itself", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.linkKind).toBe("website");
    expect(stored.requestStatus).toBe("queued_for_scan");
    // submit() itself never fetches the target — that only happens once
    // the queue is actually processed.
    expect(fetchCalled).toBe(false);
  });

  it("asks for the queue to be processed soon when a website is queued, but not otherwise", async () => {
    let scheduleCalls = 0;
    const { service } = buildService({
      scheduleQueueProcessing: async () => {
        scheduleCalls++;
      }
    });
    await service.submit(baseRequest({ link: "https://lepetitcafe.example/" }), "caller-1", null);
    expect(scheduleCalls).toBe(1);
    await service.submit(baseRequest({ link: "https://instagram.com/x" }), "caller-2", null);
    expect(scheduleCalls).toBe(1); // unchanged — no website target to queue
  });

  // Task #5A-fix round 3 §1: a failure to durably establish queue
  // processing must NOT produce a normal accepted-success outcome — the
  // previous "swallow it, the next request may wake it up" behavior
  // could strand a request with no guaranteed future wake-up.
  it("a failing scheduleQueueProcessing does not return an accepted-success outcome, and does not leave the row queued forever", async () => {
    const store = new InMemoryPublicIntakeStore();
    const service = new PublicIntakeService({
      store,
      auditLedger: new AuditLedgerService(new InMemoryAuditLedgerStore()),
      ai: successfulAi(),
      fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      scheduleQueueProcessing: async () => {
        throw new Error("internal scheduling detail — must never reach the caller");
      }
    });

    await expect(
      service.submit(baseRequest({ link: "https://lepetitcafe.example/" }), "caller-1", null)
    ).rejects.toThrow();

    // Exactly one row was inserted (submit() got as far as insertRequest
    // before scheduling failed) and it must NOT be left in queued_for_scan.
    const rows = store.listRequests(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestStatus).toBe("analysis_failed");
    expect(rows[0].analysisErrorCode).toBe("queue_schedule_failed");
    expect(store.listQueuedForScan(10)).toHaveLength(0);
  });

  it("public-intake-route.ts's boundary turns a schedule failure into a generic try_again_later, never the internal reason", async () => {
    const store = new InMemoryPublicIntakeStore();
    const service = new PublicIntakeService({
      store,
      auditLedger: new AuditLedgerService(new InMemoryAuditLedgerStore()),
      ai: successfulAi(),
      fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      scheduleQueueProcessing: async () => {
        throw new Error("internal scheduling detail — must never reach the caller");
      }
    });
    // Mirrors exactly what public-intake-route.ts's try/catch does with
    // whatever submit() throws — see public-intake-route.test.ts for the
    // full HTTP-level regression of this same guarantee.
    try {
      await service.submit(
        baseRequest({ link: "https://lepetitcafe.example/" }),
        "caller-1",
        null
      );
      expect.unreachable();
    } catch (error) {
      const publicPayload = { ok: false, error: "try_again_later" };
      expect(JSON.stringify(publicPayload)).not.toContain("internal scheduling detail");
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("rejects an unsupported-protocol target as a harmless other_reference — request still accepted, no scan run", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    // http:// (not https) fails on protocol, not on hostname/IP — a
    // harmless downgrade, never a scan target.
    const outcome = await service.submit(
      baseRequest({ link: "http://127.0.0.1/admin" }),
      "caller-1",
      null
    );
    expect(fetchCalled).toBe(false);
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.linkKind).toBe("other_reference");
    expect(stored.requestStatus).toBe("needs_target_review");
  });

  // Task #5A-fix §4: distinct from the merely-unsupported-protocol case
  // above — an explicit unsafe website URL (private/reserved hostname or
  // IP) rejects the whole request before anything is stored, rather than
  // silently downgrading to a harmless reference.
  it("rejects the entire request as invalid_request for an explicit unsafe target URL, storing nothing", async () => {
    let fetchCalled = false;
    const { service, store } = buildService({
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://169.254.169.254/latest/meta-data/" }),
      "caller-1",
      null
    );
    expect(outcome).toMatchObject({ accepted: false, reason: "invalid_request" });
    expect(fetchCalled).toBe(false);
    expect(store.listRequests(10)).toHaveLength(0);
  });
});

describe("PublicIntakeService.submit — abuse controls", () => {
  it("enforces the per-caller rate limit", async () => {
    const { service } = buildService();

    const outcomes = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(await service.submit(baseRequest(), "same-caller", null));

    expect(outcomes.filter((o) => o.accepted)).toHaveLength(3);
    const rejected = outcomes.find((o) => !o.accepted);
    expect(rejected).toMatchObject({ accepted: false, reason: "rate_limited" });
  });

  it("does not rate-limit a different caller", async () => {
    const { service } = buildService();
    for (let i = 0; i < 3; i++) await service.submit(baseRequest(), "caller-a", null);
    const outcome = await service.submit(baseRequest(), "caller-b", null);
    expect(outcome.accepted).toBe(true);
  });

  it("path/query variants of the same host normalize to the same cooldown key", () => {
    expect(normalizeScanTargetKey("https://example.com/")).toBe(
      normalizeScanTargetKey("https://example.com/?x=1")
    );
    expect(normalizeScanTargetKey("https://example.com/")).toBe(
      normalizeScanTargetKey("https://example.com/about")
    );
    expect(normalizeScanTargetKey("https://www.example.com/")).toBe(
      normalizeScanTargetKey("https://example.com/")
    );
  });
});

describe("PublicIntakeService — no Discovery/CRM/outreach side effects", () => {
  it("touches only the intake store and the audit ledger — no other tables/modules involved", async () => {
    const { service, store } = buildService({ fetcher: websiteFetcher(SAFE_HTML) });

    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    // The only persisted state is the inbound request itself — nothing
    // else exists to inspect here (no leads/discovery/drafts modules are
    // even imported by public-intake-service.ts).
    expect(store.listRequests(10)).toHaveLength(1);
  });
});

// -- Task #5A-fix §5 — the intake queue itself: nothing is ever stranded --

describe("PublicIntakeService.processQueue — draining the queue", () => {
  it("processes a queued website request through to scan_ready_needs_review", async () => {
    const { service, store } = buildService({ fetcher: websiteFetcher(SAFE_HTML) });
    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    expect(store.getRequest((outcome as { id: string }).id)!.requestStatus).toBe(
      "queued_for_scan"
    );

    const { remainingQueued } = await service.processQueue(Date.now(), 20);
    expect(remainingQueued).toBe(false);

    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("scan_ready_needs_review");
    expect(record.scanId).toBeTruthy();
    expect(record.scanStatus).toBe("completed");
  });

  it("no accepted website request is ever left permanently stranded in received/queued_for_scan", async () => {
    const { service, store } = buildService({ fetcher: websiteFetcher(SAFE_HTML) });
    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(["scan_ready_needs_review", "analysis_failed", "needs_target_review"]).toContain(
      record.requestStatus
    );
  });

  it("releases the reservation on scan failure (AI failure) — never left stuck in scanning", async () => {
    const { service, store } = buildService({
      ai: fakeAi(async () => ({ response: "not valid json" })),
      fetcher: websiteFetcher(SAFE_HTML)
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("analysis_failed");
    expect(record.scanStatus).toBe("failed");
    expect(record.analysisErrorCode).toBeTruthy();
  });

  it("releases the reservation on an unexpected fetch failure — never left stuck in scanning", async () => {
    const { service, store } = buildService({
      fetcher: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("analysis_failed");
    expect(record.requestStatus).not.toBe("scanning");
  });

  it("respects the global concurrency cap, leaving excess rows queued for a later pass", async () => {
    const store = new InMemoryPublicIntakeStore();
    const now = new Date().toISOString();
    // Pre-seed MAX_CONCURRENT_PUBLIC_SCANS (2) already "scanning".
    for (const id of ["busy-1", "busy-2"])
      store.insertRequest({
        id,
        createdAt: now,
        updatedAt: now,
        name: "x",
        businessName: "x",
        city: "x",
        supportNeed: "unknown",
        email: "x@example.com",
        linkKind: "website",
        language: "fr",
        requestStatus: "scanning",
        privacyAcceptedAt: now
      });

    let scanAttempted = false;
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempted = true;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://newtarget.example/" }),
      "caller-1",
      null
    );
    expect(store.getRequest((outcome as { id: string }).id)!.requestStatus).toBe(
      "queued_for_scan"
    );

    const { remainingQueued } = await service.processQueue(Date.now(), 20);
    expect(scanAttempted).toBe(false);
    expect(remainingQueued).toBe(true); // still queued — capacity was full
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("queued_for_scan"); // NOT a dead end — a later pass will pick it up
  });

  it("is idempotent: re-running processQueue after a row has already completed does not re-scan it", async () => {
    let scanAttempts = 0;
    const { service, store } = buildService({
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });
    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    expect(scanAttempts).toBe(1);
    // A second, redundant pass (simulating an at-least-once re-delivery of
    // the scheduled callback) must not re-scan an already-terminal row.
    await service.processQueue(Date.now(), 20);
    expect(scanAttempts).toBe(1);
    expect(store.getRequest((outcome as { id: string }).id)!.requestStatus).toBe(
      "scan_ready_needs_review"
    );
  });

  // Task #5A-fix round 4 §2 required regression: a hard interruption
  // between "reserve a scanning slot" and "reach a terminal status" (the
  // Agent scheduled callback itself was killed/reset by the platform, and
  // the SDK's retry fires again seconds later — long before the row is
  // stale) must not silently drop the row. This is deliberately DIFFERENT
  // from the existing "STALE scanning row" tests above, which all start
  // from an already-stale row; this one starts fresh.
  it("a fresh (non-stale) scanning row with no queued work still reports remaining work, and is left untouched", async () => {
    const store = new InMemoryPublicIntakeStore();
    const freshTime = new Date(Date.now() - 10_000).toISOString(); // 10s old — well under any stale threshold
    store.insertRequest({
      id: "mid-flight",
      createdAt: freshTime,
      updatedAt: freshTime,
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      submittedLink: "https://lepetitcafe.example/",
      scanTargetKey: "lepetitcafe.example",
      scanReuseKey: "https://lepetitcafe.example/",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: freshTime
    });

    let scanAttempts = 0;
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    // First pass: no queued_for_scan rows exist at all — the only work is
    // the fresh "scanning" row from the interrupted attempt.
    const { remainingQueued } = await service.processQueue(Date.now(), 20);

    expect(remainingQueued).toBe(true); // MUST require a future pass
    expect(scanAttempts).toBe(0); // did not launch a redundant scan
    expect(store.getRequest("mid-flight")!.requestStatus).toBe("scanning"); // left exactly as-is — not reset yet
  });

  it("a later pass recovers the row once it actually goes stale, and it reaches a terminal state", async () => {
    const store = new InMemoryPublicIntakeStore();
    const t0 = Date.now();
    const startTime = new Date(t0).toISOString();
    store.insertRequest({
      id: "mid-flight",
      createdAt: startTime,
      updatedAt: startTime,
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      submittedLink: "https://lepetitcafe.example/",
      scanTargetKey: "lepetitcafe.example",
      scanReuseKey: "https://lepetitcafe.example/",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: startTime
    });

    const { service } = buildService({ store, fetcher: websiteFetcher(SAFE_HTML) });

    // Still fresh (10s in) — must not be touched.
    const first = await service.processQueue(t0 + 10_000, 20);
    expect(first.remainingQueued).toBe(true);
    expect(store.getRequest("mid-flight")!.requestStatus).toBe("scanning");

    // Now past SCAN_RESERVATION_MAX_AGE_MS (3 minutes) — recovered,
    // reprocessed, and reaches a real terminal state in the SAME pass.
    const second = await service.processQueue(t0 + 4 * 60 * 1000, 20);
    const recovered = store.getRequest("mid-flight")!;
    expect(recovered.requestStatus).toBe("scan_ready_needs_review");
    expect(second.remainingQueued).toBe(false);
  });
});

describe("PublicIntakeService.processQueue — target cooldown/reuse (Task #5A-fix round 3 §3)", () => {
  it("reuses a recent completed scan for the exact SAME normalized target instead of re-scanning", async () => {
    let scanAttempts = 0;
    const store = new InMemoryPublicIntakeStore();
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const first = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    expect(scanAttempts).toBe(1);
    const firstRecord = store.getRequest((first as { id: string }).id)!;
    expect(firstRecord.requestStatus).toBe("scan_ready_needs_review");

    const second = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }), // exact same URL
      "caller-2",
      null
    );
    await service.processQueue(Date.now(), 20);

    expect(scanAttempts).toBe(1); // no second scan
    const secondRecord = store.getRequest((second as { id: string }).id)!;
    expect(secondRecord.requestStatus).toBe("scan_ready_needs_review");
    expect(secondRecord.scanId).toBe(firstRecord.scanId); // linked, not duplicated
  });

  it("does NOT reuse a completed scan for a DIFFERENT path on the same hostname — ReelScan v1 scans one specific page", async () => {
    let scanAttempts = 0;
    const store = new InMemoryPublicIntakeStore();
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const first = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    const firstRecord = store.getRequest((first as { id: string }).id)!;
    expect(firstRecord.requestStatus).toBe("scan_ready_needs_review");

    const second = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/menu" }), // different path, same host
      "caller-2",
      null
    );
    await service.processQueue(Date.now(), 20);

    expect(scanAttempts).toBe(2); // a genuinely separate scan ran
    const secondRecord = store.getRequest((second as { id: string }).id)!;
    expect(secondRecord.requestStatus).toBe("scan_ready_needs_review");
    expect(secondRecord.scanId).not.toBe(firstRecord.scanId); // NOT linked — different page
  });

  it("hostname-level abuse cooldown (scanTargetKey) is unaffected by the exact-URL reuse key change", () => {
    // Both distinct paths still normalize to the same COOLDOWN identity —
    // only scan-result REUSE requires an exact match, not the abuse
    // cooldown itself.
    expect(normalizeScanTargetKey("https://lepetitcafe.example/")).toBe(
      normalizeScanTargetKey("https://lepetitcafe.example/menu")
    );
  });

  it("does NOT apply the full successful-scan cooldown after a transient technical failure", async () => {
    const store = new InMemoryPublicIntakeStore();
    let attempt = 0;
    const { service } = buildService({
      store,
      // Fails the first scan, succeeds the second.
      fetcher: (async () => {
        attempt++;
        if (attempt === 1) return new Response("nope", { status: 503 });
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const first = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const t0 = Date.now();
    await service.processQueue(t0, 20);
    expect(store.getRequest((first as { id: string }).id)!.requestStatus).toBe(
      "analysis_failed"
    );

    // A second request for the same target, well past the (much shorter)
    // failed-scan backoff but nowhere near the 24h successful-scan
    // cooldown, must be allowed to retry rather than being blocked for a
    // full day by one bad request.
    const second = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-2",
      null
    );
    const t1 = t0 + 11 * 60 * 1000; // 11 minutes later — past the 10-minute backoff
    await service.processQueue(t1, 20);
    const secondRecord = store.getRequest((second as { id: string }).id)!;
    expect(secondRecord.requestStatus).toBe("scan_ready_needs_review");
  });

  it("defers (does not retry) a target within its short failed-scan backoff window", async () => {
    const store = new InMemoryPublicIntakeStore();
    let scanAttempts = 0;
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempts++;
        return new Response("nope", { status: 503 });
      }) as unknown as typeof fetch
    });

    const first = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const t0 = Date.now();
    await service.processQueue(t0, 20);
    expect(scanAttempts).toBe(1);
    expect(store.getRequest((first as { id: string }).id)!.requestStatus).toBe(
      "analysis_failed"
    );

    const second = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-2",
      null
    );
    // Only 1 minute later — still within the 10-minute backoff.
    const { remainingQueued } = await service.processQueue(t0 + 60_000, 20);
    expect(scanAttempts).toBe(1); // no retry yet
    expect(remainingQueued).toBe(true);
    expect(store.getRequest((second as { id: string }).id)!.requestStatus).toBe(
      "queued_for_scan"
    );
  });

  it("does not launch a duplicate simultaneous scan for a target that is already in flight", async () => {
    const store = new InMemoryPublicIntakeStore();
    const now = new Date().toISOString();
    // Simulates a currently-running scan for lepetitcafe.example.
    store.insertRequest({
      id: "in-flight",
      createdAt: now,
      updatedAt: now,
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      scanTargetKey: "lepetitcafe.example",
      scanReuseKey: "https://lepetitcafe.example/",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: now
    });

    let scanAttempts = 0;
    const { service } = buildService({
      store,
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const { remainingQueued } = await service.processQueue(Date.now(), 20);
    expect(scanAttempts).toBe(0); // did not launch a second, duplicate scan
    expect(remainingQueued).toBe(true); // still queued — will be reconsidered later
    expect(store.getRequest((outcome as { id: string }).id)!.requestStatus).toBe(
      "queued_for_scan"
    );
  });

  it("a STALE 'scanning' row for the same target does not block a fresh attempt (recovery)", async () => {
    const store = new InMemoryPublicIntakeStore();
    const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old
    store.insertRequest({
      id: "stuck",
      createdAt: staleTime,
      updatedAt: staleTime,
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      submittedLink: "https://lepetitcafe.example/other-page",
      scanTargetKey: "lepetitcafe.example",
      scanReuseKey: "https://lepetitcafe.example/other-page",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: staleTime
    });

    const { service, store: usedStore } = buildService({
      store,
      fetcher: websiteFetcher(SAFE_HTML)
    });
    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);
    expect(usedStore.getRequest((outcome as { id: string }).id)!.requestStatus).toBe(
      "scan_ready_needs_review"
    );
  });

  it("the stale row itself is recovered and re-processed (round 3 §2), not merely unblocked", async () => {
    const store = new InMemoryPublicIntakeStore();
    const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.insertRequest({
      id: "stuck",
      createdAt: staleTime,
      updatedAt: staleTime,
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      submittedLink: "https://lepetitcafe.example/",
      scanTargetKey: "lepetitcafe.example",
      scanReuseKey: "https://lepetitcafe.example/",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: staleTime
    });

    const { service, store: usedStore } = buildService({
      store,
      fetcher: websiteFetcher(SAFE_HTML)
    });
    await service.processQueue(Date.now(), 20);
    // The originally-stuck row itself reached a terminal state — it was
    // not just "unblocked" for some OTHER new request to take its place.
    expect(usedStore.getRequest("stuck")!.requestStatus).toBe(
      "scan_ready_needs_review"
    );
  });
});

describe("listInboundRequestsForManager", () => {
  it("summarizes a completed scan with score and recommendation, without raw evidence", async () => {
    const { service, store, auditLedger } = buildService({ fetcher: websiteFetcher(SAFE_HTML) });
    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    await service.processQueue(Date.now(), 20);

    const views = listInboundRequestsForManager(store, auditLedger);
    expect(views).toHaveLength(1);
    expect(views[0].requestStatus).toBe("scan_ready_needs_review");
    expect(typeof views[0].score).toBe("number");
    expect(views[0].recommendation).toBeTruthy();
    expect((views[0] as unknown as { findings?: unknown }).findings).toBeUndefined();
    expect((views[0] as unknown as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it("does not attach a score for a needs_target_review request", async () => {
    const { service, store, auditLedger } = buildService();
    await service.submit(baseRequest(), "caller-1", null);

    const views = listInboundRequestsForManager(store, auditLedger);
    expect(views[0].score).toBeUndefined();
  });

  it("does not attach a score for a still-queued request", async () => {
    const { service, store, auditLedger } = buildService({ fetcher: websiteFetcher(SAFE_HTML) });
    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const views = listInboundRequestsForManager(store, auditLedger);
    expect(views[0].requestStatus).toBe("queued_for_scan");
    expect(views[0].score).toBeUndefined();
  });
});
