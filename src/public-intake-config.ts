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

/**
 * A separate, looser limit on syntactically-valid attempts that reach
 * Turnstile's siteverify — evaluated BEFORE Turnstile is called, so an
 * attacker with fake tokens can't force unlimited siteverify calls just
 * because every one of them fails verification. Deliberately more
 * permissive than PUBLIC_RATE_LIMIT: it exists to bound verification
 * traffic, not to gate legitimate submissions (a real customer occasionally
 * mistyping/retrying should never hit this before they hit the accepted-
 * request limit above). Same pseudonymous caller-key, a distinct storage
 * key namespace (see VERIFICATION_ATTEMPT_KEY_PREFIX) so it never shares a
 * counter with the accepted-intake window.
 */
export const PRE_TURNSTILE_ATTEMPT_LIMIT = {
  maxAttemptsPerWindow: 20,
  windowSeconds: 60 * 60 // 1 hour
} as const;

export const VERIFICATION_ATTEMPT_KEY_PREFIX = "verify-attempt:";

/**
 * Cooldown after a SUCCESSFULLY completed scan of a target — reuse that
 * result for a new request on the same target within this window rather
 * than re-running AI. See normalizeScanTargetKey() in
 * public-intake-service.ts.
 */
export const TARGET_SCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Task #5A-fix §6: a transient technical failure (Workers AI hiccup, a
 * fetch timeout) must NOT poison a target for the full successful-scan
 * cooldown above — that would mean one bad request blocks every future
 * customer asking about the same site for a full day. A much shorter
 * backoff applies instead, after which the queue processor retries the
 * target normally.
 */
export const FAILED_SCAN_RETRY_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

export const MAX_CONCURRENT_PUBLIC_SCANS = 2;

/**
 * A "scanning" reservation older than this is treated as stale and
 * released. Set comfortably above ReelScan's own REELSCAN_AI_TIMEOUT_MS
 * (60s) to allow for the target fetch and post-processing around it,
 * without letting a genuinely stuck request hold a concurrency slot
 * indefinitely. Also used to decide whether an in-flight "scanning" row
 * for the same target should block a duplicate scan (see
 * isTargetCurrentlyScanning in public-intake-store.ts) — a stale row
 * never blocks anything.
 */
export const SCAN_RESERVATION_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Intake queue (Task #5A-fix §5): how many queued_for_scan requests one
 * queue-processing pass looks at. This is a query-size cap, not the real
 * throughput limit — MAX_CONCURRENT_PUBLIC_SCANS still gates how many of
 * them actually start a scan in a given pass; the rest stay queued for a
 * later pass. Generous relative to the concurrency cap so a burst of
 * accepted requests is still visible to one pass (and can be individually
 * evaluated for cooldown/reuse/in-flight-target skips) even though only a
 * couple can actually launch a scan at once.
 */
export const QUEUE_BATCH_LIMIT = 20;

/** How soon to re-check the queue when work remains after a pass. */
export const QUEUE_RETRY_DELAY_SECONDS = 30;

export const TURNSTILE_ACTION = "reelscan_intake";
export const TURNSTILE_ALLOWED_HOSTNAMES = [
  "reelhaus.de",
  "www.reelhaus.de"
] as const;

export const PUBLIC_CORS_ORIGINS = [
  "https://reelhaus.de",
  "https://www.reelhaus.de"
] as const;
