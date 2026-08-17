import { describe, expect, it } from "vitest";
import type { WorkersAiBinding } from "./ai-service";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import {
  PublicIntakeService,
  listInboundRequestsForManager,
  normalizeScanTargetKey
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

describe("PublicIntakeService.submit — link handling", () => {
  it("accepts a request with no link and marks it needs_target_review, without attempting a scan", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let fetchCalled = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
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
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let fetchCalled = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
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
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let fetchCalled = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
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

  it("classifies a normal safe website and reaches the ReelScan pipeline", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: websiteFetcher(SAFE_HTML)
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const stored = store.getRequest((outcome as { id: string }).id)!;
    expect(stored.linkKind).toBe("website");
    expect(stored.requestStatus).toBe("scan_ready_needs_review");
    expect(stored.scanId).toBeTruthy();
    expect(stored.scanStatus).toBe("completed");
  });

  it("rejects an unsafe target before any scan is attempted — request still accepted, no scan run", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let fetchCalled = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch
    });

    // An SSRF-unsafe link is classified as other_reference (never
    // "website"), so it can never become a scan target in the first place.
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
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let fetchCalled = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
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

describe("PublicIntakeService.submit — abuse/cost controls", () => {
  it("enforces the per-caller rate limit", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    });

    const outcomes = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(await service.submit(baseRequest(), "same-caller", null));

    expect(outcomes.filter((o) => o.accepted)).toHaveLength(3);
    const rejected = outcomes.find((o) => !o.accepted);
    expect(rejected).toMatchObject({ accepted: false, reason: "rate_limited" });
  });

  it("does not rate-limit a different caller", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    });
    for (let i = 0; i < 3; i++) await service.submit(baseRequest(), "caller-a", null);
    const outcome = await service.submit(baseRequest(), "caller-b", null);
    expect(outcome.accepted).toBe(true);
  });

  it("does not re-scan the same target within its cooldown window", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    let scanAttempts = 0;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () => {
        scanAttempts++;
        return new Response(SAFE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }) as unknown as typeof fetch
    });

    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const secondOutcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/menu" }), // different path, same host
      "caller-2",
      null
    );
    expect(secondOutcome.accepted).toBe(true);
    const secondRecord = store.getRequest((secondOutcome as { id: string }).id)!;
    expect(secondRecord.requestStatus).toBe("received"); // accepted, not scanned again
    expect(scanAttempts).toBe(1); // only the first scan actually ran
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

  it("respects the global concurrency cap", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    // Pre-seed the store with MAX_CONCURRENT_PUBLIC_SCANS (2) already
    // "scanning" so the next submission cannot get a slot.
    store.insertRequest({
      id: "busy-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: new Date().toISOString()
    });
    store.insertRequest({
      id: "busy-2",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: "x",
      businessName: "x",
      city: "x",
      supportNeed: "unknown",
      email: "x@example.com",
      linkKind: "website",
      language: "fr",
      requestStatus: "scanning",
      privacyAcceptedAt: new Date().toISOString()
    });

    let scanAttempted = false;
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
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
    expect(outcome.accepted).toBe(true); // still accepted — deferred, not rejected
    expect(scanAttempted).toBe(false);
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("received");
  });

  it("releases the reservation on scan failure (AI failure) — never left stuck in scanning", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: fakeAi(async () => ({ response: "not valid json" })),
      fetcher: websiteFetcher(SAFE_HTML)
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("analysis_failed");
    expect(record.scanStatus).toBe("failed");
    expect(record.analysisErrorCode).toBeTruthy();
  });

  it("releases the reservation on an unexpected fetch failure — never left stuck in scanning", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () =>
        new Response("nope", { status: 503 })) as unknown as typeof fetch
    });

    const outcome = await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    const record = store.getRequest((outcome as { id: string }).id)!;
    expect(record.requestStatus).toBe("analysis_failed");
    expect(record.requestStatus).not.toBe("scanning");
  });
});

describe("PublicIntakeService — no Discovery/CRM/outreach side effects", () => {
  it("touches only the intake store and the audit ledger — no other tables/modules involved", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: websiteFetcher(SAFE_HTML)
    });

    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );
    // The only persisted state is the inbound request + the scan's own
    // evidence/findings in the audit ledger — nothing else exists to
    // inspect here (no leads/discovery/drafts modules are even imported
    // by public-intake-service.ts).
    expect(store.listRequests(10)).toHaveLength(1);
  });
});

describe("listInboundRequestsForManager", () => {
  it("summarizes a completed scan with score and recommendation, without raw evidence", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: websiteFetcher(SAFE_HTML)
    });
    await service.submit(
      baseRequest({ link: "https://lepetitcafe.example/" }),
      "caller-1",
      null
    );

    const views = listInboundRequestsForManager(store, ledger);
    expect(views).toHaveLength(1);
    expect(views[0].requestStatus).toBe("scan_ready_needs_review");
    expect(typeof views[0].score).toBe("number");
    expect(views[0].recommendation).toBeTruthy();
    expect((views[0] as unknown as { findings?: unknown }).findings).toBeUndefined();
    expect((views[0] as unknown as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it("does not attach a score for a needs_target_review request", async () => {
    const store = new InMemoryPublicIntakeStore();
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const service = new PublicIntakeService({
      store,
      auditLedger: ledger,
      ai: successfulAi(),
      fetcher: (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    });
    await service.submit(baseRequest(), "caller-1", null);

    const views = listInboundRequestsForManager(store, ledger);
    expect(views[0].score).toBeUndefined();
  });
});
