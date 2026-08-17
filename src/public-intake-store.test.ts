import { describe, expect, it } from "vitest";
import {
  InMemoryPublicIntakeStore,
  type InboundRequestRecord
} from "./public-intake-store";

function record(overrides: Partial<InboundRequestRecord> = {}): InboundRequestRecord {
  return {
    id: "req-1",
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
    name: "Amina",
    businessName: "Le Petit Café",
    city: "Casablanca",
    supportNeed: "reelscan",
    email: "amina@example.com",
    linkKind: "website",
    submittedLink: "https://lepetitcafe.example/",
    scanTargetKey: "lepetitcafe.example",
    language: "fr",
    requestStatus: "received",
    privacyAcceptedAt: "2026-08-17T10:00:00.000Z",
    ...overrides
  };
}

describe("InMemoryPublicIntakeStore — request CRUD", () => {
  it("stores and retrieves a request", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(record());
    expect(store.getRequest("req-1")?.businessName).toBe("Le Petit Café");
  });

  it("lists requests newest first", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(record({ id: "a", createdAt: "2026-08-17T10:00:00.000Z" }));
    store.insertRequest(record({ id: "b", createdAt: "2026-08-17T11:00:00.000Z" }));
    const listed = store.listRequests(10);
    expect(listed.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("updates only the fields provided", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(record());
    store.updateRequestStatus("req-1", {
      requestStatus: "scan_ready_needs_review",
      scanId: "scan-1",
      scanStatus: "completed",
      updatedAt: "2026-08-17T10:05:00.000Z"
    });
    const updated = store.getRequest("req-1")!;
    expect(updated.requestStatus).toBe("scan_ready_needs_review");
    expect(updated.scanId).toBe("scan-1");
    expect(updated.businessName).toBe("Le Petit Café"); // untouched
  });
});

describe("InMemoryPublicIntakeStore — concurrency reservation", () => {
  it("reserves a slot when under the concurrency cap", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(record());
    const reserved = store.tryReserveScanningSlot(
      "req-1",
      "2026-08-17T10:00:00.000Z",
      2,
      120_000
    );
    expect(reserved).toBe(true);
    expect(store.getRequest("req-1")?.requestStatus).toBe("scanning");
  });

  it("coordinates the check + reservation atomically: the cap is never exceeded", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(record({ id: "a" }));
    store.insertRequest(record({ id: "b" }));
    store.insertRequest(record({ id: "c" }));

    const now = "2026-08-17T10:00:00.000Z";
    const results = ["a", "b", "c"].map((id) =>
      store.tryReserveScanningSlot(id, now, 2, 120_000)
    );
    expect(results.filter(Boolean)).toHaveLength(2); // exactly the cap, never more
    expect(results).toEqual([true, true, false]);
  });

  it("a stale (expired) reservation does not count against the cap", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        id: "stale",
        requestStatus: "scanning",
        updatedAt: "2026-08-17T09:00:00.000Z" // old
      })
    );
    store.insertRequest(record({ id: "fresh" }));

    const reserved = store.tryReserveScanningSlot(
      "fresh",
      "2026-08-17T10:00:00.000Z", // 1h later — well past a 2-minute max age
      1,
      120_000
    );
    expect(reserved).toBe(true);
  });

  it("a fresh reservation still counts against the cap", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        id: "active",
        requestStatus: "scanning",
        updatedAt: "2026-08-17T09:59:30.000Z" // 30s old
      })
    );
    store.insertRequest(record({ id: "new" }));

    const reserved = store.tryReserveScanningSlot(
      "new",
      "2026-08-17T10:00:00.000Z",
      1,
      120_000
    );
    expect(reserved).toBe(false);
  });
});

describe("InMemoryPublicIntakeStore — target cooldown/reuse lookups (Task #5A-fix §6)", () => {
  it("returns the most recent COMPLETED scan for a target, with its scanId", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        id: "a",
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "scan_ready_needs_review",
        scanId: "scan-old",
        createdAt: "2026-08-16T10:00:00.000Z"
      })
    );
    store.insertRequest(
      record({
        id: "b",
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "scan_ready_needs_review",
        scanId: "scan-new",
        createdAt: "2026-08-17T10:00:00.000Z"
      })
    );
    expect(store.latestCompletedScanForTarget("lepetitcafe.example")).toEqual({
      scanId: "scan-new",
      createdAt: "2026-08-17T10:00:00.000Z"
    });
  });

  it("does not treat a failed scan as a completed one to reuse", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "analysis_failed",
        createdAt: "2026-08-17T10:00:00.000Z"
      })
    );
    expect(store.latestCompletedScanForTarget("lepetitcafe.example")).toBeNull();
  });

  it("returns null for a target that has never completed a scan", () => {
    const store = new InMemoryPublicIntakeStore();
    expect(store.latestCompletedScanForTarget("never-seen.example")).toBeNull();
  });

  it("returns the most recent failed-scan timestamp for a target", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "analysis_failed",
        createdAt: "2026-08-17T10:00:00.000Z"
      })
    );
    expect(store.latestFailedScanAtForTarget("lepetitcafe.example")).toBe(
      "2026-08-17T10:00:00.000Z"
    );
  });

  it("does not count a merely-queued (not yet attempted) request as a failure", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({ scanTargetKey: "lepetitcafe.example", requestStatus: "queued_for_scan" })
    );
    expect(store.latestFailedScanAtForTarget("lepetitcafe.example")).toBeNull();
  });

  it("reports a target as currently scanning only while a fresh scanning row exists", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "scanning",
        updatedAt: "2026-08-17T09:59:30.000Z" // 30s old
      })
    );
    expect(
      store.isTargetCurrentlyScanning(
        "lepetitcafe.example",
        "2026-08-17T10:00:00.000Z",
        120_000
      )
    ).toBe(true);
  });

  it("a STALE scanning row does not block a new attempt at the same target", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({
        scanTargetKey: "lepetitcafe.example",
        requestStatus: "scanning",
        updatedAt: "2026-08-17T09:00:00.000Z" // 1h old — well past a 2-minute max age
      })
    );
    expect(
      store.isTargetCurrentlyScanning(
        "lepetitcafe.example",
        "2026-08-17T10:00:00.000Z",
        120_000
      )
    ).toBe(false);
  });
});

describe("InMemoryPublicIntakeStore — intake queue listing", () => {
  it("lists queued_for_scan requests oldest first", () => {
    const store = new InMemoryPublicIntakeStore();
    store.insertRequest(
      record({ id: "b", requestStatus: "queued_for_scan", createdAt: "2026-08-17T11:00:00.000Z" })
    );
    store.insertRequest(
      record({ id: "a", requestStatus: "queued_for_scan", createdAt: "2026-08-17T10:00:00.000Z" })
    );
    store.insertRequest(record({ id: "c", requestStatus: "scanning" }));
    expect(store.listQueuedForScan(10).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("respects the batch limit", () => {
    const store = new InMemoryPublicIntakeStore();
    for (let i = 0; i < 5; i++)
      store.insertRequest(record({ id: `q-${i}`, requestStatus: "queued_for_scan" }));
    expect(store.listQueuedForScan(2)).toHaveLength(2);
  });
});

describe("InMemoryPublicIntakeStore — rate limit windows", () => {
  it("starts a window on first touch", () => {
    const store = new InMemoryPublicIntakeStore();
    store.touchRateLimitWindow("caller-a", 1000, 3600);
    expect(store.getRateLimitWindow("caller-a")).toEqual({
      count: 1,
      windowStartSeconds: 1000
    });
  });

  it("increments an existing window within its lifetime", () => {
    const store = new InMemoryPublicIntakeStore();
    store.touchRateLimitWindow("caller-a", 1000, 3600);
    store.touchRateLimitWindow("caller-a", 1010, 3600);
    expect(store.getRateLimitWindow("caller-a")?.count).toBe(2);
  });

  it("starts a fresh window once the previous one has elapsed", () => {
    const store = new InMemoryPublicIntakeStore();
    store.touchRateLimitWindow("caller-a", 1000, 3600);
    store.touchRateLimitWindow("caller-a", 1000 + 3600, 3600);
    expect(store.getRateLimitWindow("caller-a")).toEqual({
      count: 1,
      windowStartSeconds: 1000 + 3600
    });
  });

  it("purges only windows stale well beyond their own lifetime", () => {
    const store = new InMemoryPublicIntakeStore();
    store.touchRateLimitWindow("stale", 1000, 3600);
    store.touchRateLimitWindow("fresh", 1000 + 3600 * 3, 3600);
    store.purgeStaleRateLimitWindows(1000 + 3600 * 3, 3600);
    expect(store.getRateLimitWindow("stale")).toBeNull();
    expect(store.getRateLimitWindow("fresh")).not.toBeNull();
  });
});
