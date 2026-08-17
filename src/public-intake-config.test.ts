// Task #5A-fix round 4 §4: pins the queue-processing timing invariant so
// any future change to one of these five numbers fails loudly here rather
// than silently reintroducing "legitimate scan treated as hung/stale."
import { describe, expect, it } from "vitest";
import {
  AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS,
  PUBLIC_TARGET_FETCH_TIMEOUT_MS,
  QUEUE_PROCESSING_MARGIN_MS,
  SCAN_RESERVATION_MAX_AGE_MS
} from "./public-intake-config";
import { REELSCAN_AI_TIMEOUT_MS } from "./reelscan";

describe("queue-processing timing invariant", () => {
  it("bounds a legitimate scan strictly under the Agent hung-schedule timeout", () => {
    const boundedScanRuntimeMs =
      PUBLIC_TARGET_FETCH_TIMEOUT_MS + REELSCAN_AI_TIMEOUT_MS + QUEUE_PROCESSING_MARGIN_MS;
    expect(boundedScanRuntimeMs).toBeLessThan(AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS * 1000);
  });

  it("keeps the Agent hung-schedule timeout strictly under the stale-reservation age", () => {
    expect(AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS * 1000).toBeLessThan(
      SCAN_RESERVATION_MAX_AGE_MS
    );
  });

  it("does not reduce the AI timeout to fit an unrelated budget — it stays the ReelScan-calibrated 60s", () => {
    expect(REELSCAN_AI_TIMEOUT_MS).toBe(60_000);
  });

  it("each stage of the invariant has real headroom, not a pinned-exact fit", () => {
    const boundedScanRuntimeMs =
      PUBLIC_TARGET_FETCH_TIMEOUT_MS + REELSCAN_AI_TIMEOUT_MS + QUEUE_PROCESSING_MARGIN_MS;
    const agentTimeoutMs = AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS * 1000;
    expect(agentTimeoutMs - boundedScanRuntimeMs).toBeGreaterThanOrEqual(10_000);
    expect(SCAN_RESERVATION_MAX_AGE_MS - agentTimeoutMs).toBeGreaterThanOrEqual(10_000);
  });
});
