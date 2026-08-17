// Centralized, free-first configuration for the public ReelScan intake.
// Route/service logic must reference these values rather than hardcoding
// its own numbers, so every limit lives in exactly one place.

/** The public payload is tiny by design — see public-request-schema.ts. */
export const MAX_PUBLIC_BODY_BYTES = 16 * 1024; // 16 KiB

export const PUBLIC_RATE_LIMIT = {
  /** Conservative v1 starting point: accepted requests, not merely attempts. */
  maxAcceptedPerWindow: 3,
  windowSeconds: 60 * 60 // 1 hour
} as const;

/** Per-target-hostname cooldown — see normalizeScanTargetKey() in public-intake-store.ts. */
export const TARGET_SCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export const MAX_CONCURRENT_PUBLIC_SCANS = 2;

/**
 * A "scanning" reservation older than this is treated as stale and
 * released. Set comfortably above ReelScan's own REELSCAN_AI_TIMEOUT_MS
 * (60s) to allow for the target fetch and post-processing around it,
 * without letting a genuinely stuck request hold a concurrency slot
 * indefinitely.
 */
export const SCAN_RESERVATION_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes

export const TURNSTILE_ACTION = "reelscan_intake";
export const TURNSTILE_ALLOWED_HOSTNAMES = [
  "reelhaus.de",
  "www.reelhaus.de"
] as const;

export const PUBLIC_CORS_ORIGINS = [
  "https://reelhaus.de",
  "https://www.reelhaus.de"
] as const;
