import { describe, expect, it } from "vitest";
import {
  evaluateConcurrencyCap,
  evaluateRateLimit,
  evaluateTargetCooldown
} from "./rate-limit";

describe("evaluateRateLimit", () => {
  it("allows the first request (no existing window)", () => {
    expect(evaluateRateLimit(null, 1000).allowed).toBe(true);
  });

  it("allows requests under the cap within the window", () => {
    const decision = evaluateRateLimit(
      { count: 2, windowStartSeconds: 1000 },
      1010,
      5,
      3600
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks once the cap is reached within the window", () => {
    const decision = evaluateRateLimit(
      { count: 5, windowStartSeconds: 1000 },
      1010,
      5,
      3600
    );
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows again once the window has fully elapsed", () => {
    const decision = evaluateRateLimit(
      { count: 5, windowStartSeconds: 1000 },
      1000 + 3600,
      5,
      3600
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateConcurrencyCap", () => {
  it("allows scans under the concurrency cap", () => {
    expect(evaluateConcurrencyCap(0, 2)).toBe(true);
    expect(evaluateConcurrencyCap(1, 2)).toBe(true);
  });

  it("blocks once the concurrency cap is reached", () => {
    expect(evaluateConcurrencyCap(2, 2)).toBe(false);
  });
});

describe("evaluateTargetCooldown", () => {
  it("allows a target that has never been scanned", () => {
    expect(evaluateTargetCooldown(null, Date.parse("2026-08-17T12:00:00Z")).allowed).toBe(
      true
    );
  });

  it("blocks a target scanned within the cooldown window", () => {
    const lastScanAt = "2026-08-17T12:00:00.000Z";
    const now = Date.parse("2026-08-17T13:00:00.000Z"); // 1h later
    const decision = evaluateTargetCooldown(lastScanAt, now, 24 * 60 * 60 * 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows a target once the cooldown has elapsed", () => {
    const lastScanAt = "2026-08-17T12:00:00.000Z";
    const now = Date.parse("2026-08-18T13:00:00.000Z"); // 25h later
    const decision = evaluateTargetCooldown(lastScanAt, now, 24 * 60 * 60 * 1000);
    expect(decision.allowed).toBe(true);
  });
});
