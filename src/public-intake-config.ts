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

// -- Task #5A-fix round 4 §1/§4 — the queue-processing timing invariant --
//
// A legitimate scan runs entirely inside one Agent scheduled callback
// (sales-agent.ts's processInboundScanQueue -> PublicIntakeService.
// processQueue -> runReelScanV1Target), so every timeout in that chain
// must nest strictly inside the next:
//
//   PUBLIC_TARGET_FETCH_TIMEOUT_MS         (20s  — safe-fetch total budget)
//   + REELSCAN_AI_TIMEOUT_MS               (60s  — reelscan.ts, UNCHANGED)
//   + QUEUE_PROCESSING_MARGIN_MS           (10s  — evidence/scoring/persist)
//   = 90s  bounded legitimate scan runtime
//   <
//   AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS    (120s — sales-agent.ts static options)
//   <
//   SCAN_RESERVATION_MAX_AGE_MS            (180s — this file)
//
// Each step has real headroom (30s) rather than being pinned to the exact
// sum, so normal jitter (GC pauses, a slightly slow evidence pass) can't
// tip a legitimate scan into either bucket meant for genuinely stuck work.
// docs: this whole chain is exercised by a dedicated test in
// public-intake-config.test.ts that fails loudly if any of these five
// numbers drift out of the required order — see that file before changing
// any of them.

/**
 * Total wall-clock budget for fetching ONE public customer target through
 * safe-fetch.ts — covers the initial connection, every redirect hop, AND
 * streaming the final response body (a slow/stalled body after headers
 * arrive is bounded exactly like a slow initial connection; see
 * safe-fetch.ts). Passed explicitly as runReelScanV1Target's
 * safeFetchPublicUrl({ totalTimeoutMs }) call in reelscan.ts.
 */
export const PUBLIC_TARGET_FETCH_TIMEOUT_MS = 20_000; // 20s

/**
 * Margin added on top of (fetch + AI) for the deterministic work around
 * them — generic-website-checks.ts's regex extraction, evidence
 * recording, consolidation/severity-floor/scoring, and the store writes
 * that persist the outcome. All of that is fast in practice; this is
 * deliberately generous headroom, not a measured worst case.
 */
export const QUEUE_PROCESSING_MARGIN_MS = 10_000; // 10s

/**
 * Configures ReelHausManager's `static options.hungScheduleTimeoutSeconds`
 * (sales-agent.ts) — the agents SDK's default (30s) is well under a
 * legitimate scan's ~90s bounded runtime and would let the SDK treat an
 * in-progress, healthy scan as "hung." Must stay strictly greater than
 * PUBLIC_TARGET_FETCH_TIMEOUT_MS + REELSCAN_AI_TIMEOUT_MS +
 * QUEUE_PROCESSING_MARGIN_MS (90s) — see the invariant above.
 */
export const AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS = 120; // 2 minutes

/**
 * A "scanning" reservation older than this is treated as stale and
 * recovered back to queued_for_scan (see recoverStaleScanningRows in
 * public-intake-store.ts). Must stay strictly greater than
 * AGENT_HUNG_SCHEDULE_TIMEOUT_SECONDS — otherwise a row could be reaped
 * as "stale" while the Agent scheduler itself still considers the
 * callback that's actively working on it healthy, permitting a second,
 * duplicate scan of the same target to start concurrently. Also used to
 * decide whether an in-flight "scanning" row for the same exact target
 * should block a duplicate scan (see isTargetCurrentlyScanning) — a
 * stale row never blocks anything.
 */
export const SCAN_RESERVATION_MAX_AGE_MS = 3 * 60 * 1000; // 3 minutes

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

// -- Public intake retention (owner decision, see public-intake-retention.ts) --
//
// Public ReelScan inquiry records must be deleted no later than 90 days
// after the original submission date (created_at, never updated_at — an
// internal scan/status change must not silently extend retention). If a
// business later becomes a customer, information genuinely needed for that
// relationship is handled separately under its own future retention rules;
// the original public-intake record does not need to remain indefinitely.
export const PUBLIC_INTAKE_RETENTION_DAYS = 90;

/**
 * How many expired rows one cleanup pass deletes. A bound, not the real
 * backlog size — an unexpectedly large backlog (e.g. after this feature
 * first ships) is worked off over multiple scheduled passes rather than
 * attempting an unbounded delete in one Durable Object alarm tick. Mirrors
 * QUEUE_BATCH_LIMIT's role for the scan queue above.
 */
export const RETENTION_CLEANUP_BATCH_LIMIT = 200;

/**
 * Once-daily cron (agents SDK, SQLite-backed — see sales-agent.ts's
 * onStart()). 03:17 UTC: off-peak, and deliberately not a round number
 * (":00"/":30") so this doesn't line up with other scheduled-task minute
 * boundaries if any are ever added.
 */
export const RETENTION_CLEANUP_CRON = "17 3 * * *";

/**
 * If a cleanup pass fills its RETENTION_CLEANUP_BATCH_LIMIT batch (more
 * expired rows may remain), re-check this soon after rather than waiting
 * for tomorrow's cron tick — mirrors QUEUE_RETRY_DELAY_SECONDS's role for
 * the scan queue above.
 */
export const RETENTION_CLEANUP_CONTINUATION_DELAY_SECONDS = 120;

export const TURNSTILE_ACTION = "reelscan_intake";
export const TURNSTILE_ALLOWED_HOSTNAMES = [
  "reelhaus.de",
  "www.reelhaus.de"
] as const;

export const PUBLIC_CORS_ORIGINS = [
  "https://reelhaus.de",
  "https://www.reelhaus.de"
] as const;
