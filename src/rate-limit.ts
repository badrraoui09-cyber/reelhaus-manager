// Pure, deterministic abuse-control decisions for a future public ReelScan
// intake. Free-tier-compatible by design: Cloudflare's dashboard-level
// Rate Limiting Rules have historically required a paid plan (verify the
// current Free-tier allotment before relying on it — do not assume it's
// available); these functions are the free-compatible fallback, meant to
// be backed by the existing Durable Object's SQLite storage (already used
// throughout this app) rather than any paid add-on.
//
// Deliberately pure: no fetch, no storage, no clock reads. A caller (the
// future route handler) supplies the current counts/timestamps and gets
// back a decision — this keeps the policy itself trivial to test and to
// reason about independent of how/where counts are persisted.

export interface RateLimitWindow {
  count: number;
  windowStartSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

const DEFAULT_MAX_PER_WINDOW = 5;
const DEFAULT_WINDOW_SECONDS = 60 * 60; // 1 hour

/** Per-IP (or per-session) request-count limiting within a rolling window. */
export function evaluateRateLimit(
  current: RateLimitWindow | null,
  nowSeconds: number,
  maxPerWindow = DEFAULT_MAX_PER_WINDOW,
  windowSeconds = DEFAULT_WINDOW_SECONDS
): RateLimitDecision {
  if (!current) return { allowed: true };
  const windowAge = nowSeconds - current.windowStartSeconds;
  if (windowAge < 0) return { allowed: true }; // clock skew: fail open on the window, not the cap
  if (windowAge >= windowSeconds) return { allowed: true };
  if (current.count < maxPerWindow) return { allowed: true };
  return { allowed: false, retryAfterSeconds: windowSeconds - windowAge };
}

const DEFAULT_MAX_CONCURRENT_SCANS = 2;

/** A global cap on scans actively running at once, independent of caller. */
export function evaluateConcurrencyCap(
  activeScanCount: number,
  maxConcurrentScans = DEFAULT_MAX_CONCURRENT_SCANS
): boolean {
  return activeScanCount < maxConcurrentScans;
}

const DEFAULT_TARGET_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export interface TargetCooldownDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

/**
 * Prevents re-scanning the same target URL on every request — both an
 * abuse/cost control and a natural de-dup (repeat scans of an unchanged
 * page rarely produce new findings).
 */
export function evaluateTargetCooldown(
  lastScanAtIso: string | null,
  nowMs: number,
  cooldownMs = DEFAULT_TARGET_COOLDOWN_MS
): TargetCooldownDecision {
  if (!lastScanAtIso) return { allowed: true };
  const lastScanMs = Date.parse(lastScanAtIso);
  if (Number.isNaN(lastScanMs)) return { allowed: true };
  const elapsed = nowMs - lastScanMs;
  if (elapsed >= cooldownMs) return { allowed: true };
  return { allowed: false, retryAfterMs: cooldownMs - elapsed };
}
