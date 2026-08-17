// Orchestrates the inbound public ReelScan intake in two parts:
//
// 1. submit() — rate-limit, classify the optional link, persist. A safe
//    website target is never scanned inline (a customer's HTTP request
//    must not block on a fetch + up-to-60s AI call): it's marked
//    "queued_for_scan" and a queue-processing pass is scheduled. An
//    inbound request is a customer asking for a scan, never auto-
//    converted into a Discovery candidate, a lead, or an outreach draft;
//    nothing here touches those tables.
//
// 2. processQueue() — the intake queue itself (Task #5A-fix §5). Called
//    from a Durable Object schedule()d callback (see sales-agent.ts), not
//    directly by the public route. Every ACCEPTED website request is
//    guaranteed to reach a terminal/actionable state — scan_ready_needs_
//    review, analysis_failed, or (via target reuse) linked to an existing
//    completed scan — never left permanently sitting in "received"/
//    "queued_for_scan" with no mechanism to advance it.
import type { AuditLedgerService } from "./audit-ledger";
import type { WorkersAiBinding } from "./ai-service";
import { classifySubmittedLink } from "./link-classifier";
import {
  FAILED_SCAN_RETRY_BACKOFF_MS,
  MAX_CONCURRENT_PUBLIC_SCANS,
  PUBLIC_RATE_LIMIT,
  SCAN_RESERVATION_MAX_AGE_MS,
  TARGET_SCAN_COOLDOWN_MS
} from "./public-intake-config";
import type { PublicReelScanRequest } from "./public-request-schema";
import {
  type InboundRequestRecord,
  type PublicIntakeStore,
  type RequestStatus
} from "./public-intake-store";
import { evaluateRateLimit, evaluateTargetCooldown } from "./rate-limit";
import {
  ReelScanTargetError,
  calculateReelScanScore,
  recommendReelScanAction,
  runReelScanV1Target,
  type ReelScanRecommendedAction
} from "./reelscan";

/**
 * Hostname-level normalization for the target cooldown, so
 * example.com/, example.com/?x=1, and example.com/about all share one
 * cooldown key instead of burning three separate scans. Deliberately just
 * hostname + stripped "www." — no public-suffix/eTLD library is a
 * dependency of this repo, and a coarser-than-strictly-necessary cooldown
 * (e.g. two unrelated example.com subpaths sharing a cooldown) is a safe
 * direction to err in for an abuse control.
 */
export function normalizeScanTargetKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Exact-target scan-RESULT identity (Task #5A-fix round 3 §3) — distinct
 * from normalizeScanTargetKey()'s hostname-level abuse/cost cooldown key.
 * ReelScan v1 scans one specific submitted page, so reusing a completed
 * scan (or detecting an in-flight duplicate) must match the exact target,
 * not just the host: https://example.com/menu must never be served the
 * result of a scan of https://example.com/. Only the URL fragment is
 * stripped — it is never sent to the server, so two URLs differing only
 * by fragment are the same fetch target by construction. Path, query,
 * and trailing-slash presence are preserved exactly as validated; this
 * deliberately does NOT canonicalize further (e.g. to the site's
 * homepage) — that would silently rewrite an intentional customer-
 * submitted path without a product reason.
 */
export function normalizeScanReuseKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export type PublicIntakeOutcome =
  | { accepted: true; id: string }
  | { accepted: false; reason: "rate_limited" | "invalid_request" };

export interface PublicIntakeDeps {
  store: PublicIntakeStore;
  auditLedger: AuditLedgerService;
  ai: WorkersAiBinding | undefined;
  fetcher: typeof fetch;
  /**
   * Best-effort nudge to run the intake queue soon (see processQueue()).
   * In production this wraps the Durable Object's own
   * this.schedule(...) (agents SDK, SQLite-backed, idempotent by
   * callback+payload — see sales-agent.ts's processInboundScanQueue()).
   * A failure here is swallowed, not fatal: the record is already
   * durably "queued_for_scan" regardless, and self-heals the next time
   * ANY request successfully schedules a pass, or the queue processor
   * re-arms itself after a pass with work remaining.
   */
  scheduleQueueProcessing: () => Promise<void>;
}

export class PublicIntakeService {
  constructor(private readonly deps: PublicIntakeDeps) {}

  async submit(
    input: PublicReelScanRequest,
    callerKey: string,
    sourceOrigin: string | null
  ): Promise<PublicIntakeOutcome> {
    const { store } = this.deps;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const nowSeconds = Math.floor(nowMs / 1000);

    // Per-caller rate limit: synchronous read -> pure decision -> synchronous
    // conditional write, with no `await` between them (Durable Object
    // SQLite calls are synchronous), so nothing else can interleave.
    const window = store.getRateLimitWindow(callerKey);
    const rateLimitDecision = evaluateRateLimit(
      window,
      nowSeconds,
      PUBLIC_RATE_LIMIT.maxAcceptedPerWindow,
      PUBLIC_RATE_LIMIT.windowSeconds
    );
    if (!rateLimitDecision.allowed) return { accepted: false, reason: "rate_limited" };
    store.touchRateLimitWindow(callerKey, nowSeconds, PUBLIC_RATE_LIMIT.windowSeconds);
    store.purgeStaleRateLimitWindows(nowSeconds, PUBLIC_RATE_LIMIT.windowSeconds);

    const link = classifySubmittedLink(input.link);
    // An explicit unsafe target (private/reserved hostname or IP,
    // credentials in the URL) rejects the whole request before anything is
    // stored — distinct from a harmless non-website reference (Instagram,
    // Google Maps, random text), which is accepted as context. See
    // link-classifier.ts and docs/reelscan-public-intake-security.md §11.
    if (link.rejectedAsUnsafe) return { accepted: false, reason: "invalid_request" };
    const scanTargetKey =
      link.kind === "website" && link.normalizedUrl
        ? normalizeScanTargetKey(link.normalizedUrl)
        : undefined;
    const scanReuseKey =
      link.kind === "website" && link.normalizedUrl
        ? normalizeScanReuseKey(link.normalizedUrl)
        : undefined;
    const isWebsite = link.kind === "website" && Boolean(link.normalizedUrl);

    const id = crypto.randomUUID();
    const record: InboundRequestRecord = {
      id,
      createdAt: nowIso,
      updatedAt: nowIso,
      name: input.name,
      businessName: input.businessName,
      city: input.city,
      supportNeed: input.supportNeed,
      email: input.email,
      whatsapp: input.whatsapp,
      submittedLink: link.raw,
      linkKind: link.kind,
      scanTargetKey,
      scanReuseKey,
      issue: input.issue,
      language: input.language,
      // No scannable website — a legitimate business without a site is
      // not rejected, it simply needs a human to decide what happens
      // next; that's a terminal/actionable state on its own, not a
      // dead end. A safe website target is queued for the intake queue
      // to pick up — see processQueue() below.
      requestStatus: isWebsite ? "queued_for_scan" : "needs_target_review",
      sourceOrigin: sourceOrigin || undefined,
      privacyAcceptedAt: nowIso
    };
    store.insertRequest(record);

    if (isWebsite) {
      try {
        await this.deps.scheduleQueueProcessing();
      } catch (error) {
        // Task #5A-fix round 3 §1: a failure to durably establish queue
        // processing must NOT produce a normal accepted-success outcome —
        // "the next customer's request may incidentally wake it up" is
        // not a guarantee. Move the row to a terminal state so it is
        // never displayed as permanently "Queued", and propagate so the
        // public route's existing boundary (public-intake-route.ts) maps
        // this to the generic try_again_later — never exposing why.
        store.updateRequestStatus(id, {
          requestStatus: "analysis_failed",
          analysisErrorCode: "queue_schedule_failed",
          updatedAt: new Date().toISOString()
        });
        throw error;
      }
    }

    return { accepted: true, id };
  }

  /**
   * Processes up to `batchLimit` queued_for_scan requests, oldest first.
   * Safe to call repeatedly / concurrently-in-effect (Durable Object
   * schedule callbacks are serialized per instance, but this method makes
   * no assumption beyond that): every state transition goes through the
   * same atomic store primitives submit() itself used to rely on
   * (tryReserveScanningSlot's synchronous check+reserve), so re-running
   * this against the same rows is a no-op past the point they've already
   * moved out of "queued_for_scan" — at-least-once execution is safe.
   *
   * Also recovers any stale "scanning" rows back to queued_for_scan first
   * (see recoverStaleScanningRows) so an interrupted scan is retried, not
   * stuck forever.
   *
   * For each queued row with a website target:
   *  - a recent (within TARGET_SCAN_COOLDOWN_MS) COMPLETED scan for the
   *    exact same target URL (scanReuseKey) is reused (linked by scanId)
   *    instead of re-scanning — never merely the same hostname;
   *  - a currently in-flight scan of the exact same target URL defers
   *    this row to a later pass rather than launching a duplicate
   *    concurrent scan;
   *  - a recent (within FAILED_SCAN_RETRY_BACKOFF_MS) FAILED scan for the
   *    same HOSTNAME (scanTargetKey — coarser, an abuse/cost control)
   *    defers this row to a later pass — a transient technical failure
   *    must not poison the target for a full day;
   *  - otherwise it competes for a global concurrency slot exactly as
   *    before, and is skipped (left queued) if capacity is full.
   *
   * Returns whether any queued work remains, so the caller (the Durable
   * Object's scheduled callback) knows whether to re-arm.
   */
  async processQueue(
    nowMs: number,
    batchLimit: number
  ): Promise<{ remainingQueued: boolean }> {
    const { store } = this.deps;
    const nowIso = new Date(nowMs).toISOString();

    // Task #5A-fix round 3 §2: a Worker interrupted between reserving a
    // scanning slot and reaching a terminal status must not leave that
    // row permanently displayed as "Scanning" — recover it back to
    // queued_for_scan BEFORE this pass's normal work, so it's eligible
    // to be picked up in the same pass. Atomic bulk UPDATE; never touches
    // a fresh (non-stale) scan.
    store.recoverStaleScanningRows(nowIso, SCAN_RESERVATION_MAX_AGE_MS);

    const queued = store.listQueuedForScan(batchLimit);

    for (const row of queued) {
      // scanReuseKey (exact normalized target URL) gates completed-scan
      // reuse and in-flight-duplicate detection — ReelScan v1 scans one
      // specific page, so a hostname match alone is not enough (§3).
      // scanTargetKey (hostname-level) still gates the failed-scan
      // backoff — an abuse/cost control, coarse-by-design.
      if (row.scanReuseKey) {
        const completed = store.latestCompletedScanForTarget(row.scanReuseKey);
        if (
          completed &&
          evaluateTargetCooldown(completed.completedAt, nowMs, TARGET_SCAN_COOLDOWN_MS)
            .allowed === false
        ) {
          store.updateRequestStatus(row.id, {
            requestStatus: "scan_ready_needs_review",
            scanId: completed.scanId,
            scanStatus: "completed",
            scanCompletedAt: completed.completedAt,
            updatedAt: nowIso
          });
          continue;
        }

        if (
          store.isTargetCurrentlyScanning(row.scanReuseKey, nowIso, SCAN_RESERVATION_MAX_AGE_MS)
        )
          continue; // another in-flight scan of the exact same URL; wait, don't duplicate
      }

      if (row.scanTargetKey) {
        const failedAt = store.latestFailedScanAtForTarget(row.scanTargetKey);
        if (
          failedAt &&
          evaluateTargetCooldown(failedAt, nowMs, FAILED_SCAN_RETRY_BACKOFF_MS)
            .allowed === false
        ) {
          continue; // too soon to retry after a technical failure; try again next pass
        }
      }

      if (!row.submittedLink) {
        // Should not happen for a website-kind row by construction in
        // submit(), but never silently leave a row stuck if it does.
        store.updateRequestStatus(row.id, {
          requestStatus: "analysis_failed",
          analysisErrorCode: "missing_target_url",
          scanFailedAt: nowIso,
          updatedAt: nowIso
        });
        continue;
      }

      const reserved = store.tryReserveScanningSlot(
        row.id,
        nowIso,
        MAX_CONCURRENT_PUBLIC_SCANS,
        SCAN_RESERVATION_MAX_AGE_MS
      );
      // Global capacity full right now — leave queued for a later pass.
      if (!reserved) continue;

      try {
        const result = await runReelScanV1Target({
          targetUrl: row.submittedLink,
          ai: this.deps.ai,
          auditLedger: this.deps.auditLedger,
          fetcher: this.deps.fetcher
        });
        const finishedAt = new Date().toISOString();
        const finalStatus: RequestStatus =
          result.reviewStatus === "needs_review"
            ? "scan_ready_needs_review"
            : "analysis_failed";
        store.updateRequestStatus(row.id, {
          requestStatus: finalStatus,
          scanId: result.scanId,
          scanStatus: result.analysisRun.status === "completed" ? "completed" : "failed",
          analysisErrorCode:
            result.analysisRun.status === "failed"
              ? result.analysisRun.error || "analysis_failed"
              : undefined,
          // Task #5A-fix round 3 §4: the freshness/backoff clock starts
          // at scan OUTCOME time, never createdAt (the request may have
          // sat queued for a while first).
          scanCompletedAt: finalStatus === "scan_ready_needs_review" ? finishedAt : undefined,
          scanFailedAt: finalStatus === "analysis_failed" ? finishedAt : undefined,
          updatedAt: finishedAt
        });
      } catch (error) {
        // Always resolves the reservation — success and failure paths both
        // move the row out of "scanning" so it never counts against the
        // concurrency cap again after this point.
        store.updateRequestStatus(row.id, {
          requestStatus: "analysis_failed",
          analysisErrorCode:
            error instanceof ReelScanTargetError ? error.reason : "unknown_error",
          scanFailedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }

    return { remainingQueued: store.listQueuedForScan(1).length > 0 };
  }
}

export interface InboundRequestManagerView extends InboundRequestRecord {
  score?: number;
  recommendation?: ReelScanRecommendedAction;
}

/**
 * Enriches a stored request with score/recommendation for the Manager,
 * derived (never stored redundantly) from the same deterministic scoring/
 * recommendation functions Client #0 uses — reused, not reimplemented.
 * Never includes raw evidence or findings; see docs/reelscan-public-intake-security.md §17.
 */
export function summarizeInboundRequestForManager(
  record: InboundRequestRecord,
  auditLedger: AuditLedgerService
): InboundRequestManagerView {
  if (!record.scanId || record.requestStatus !== "scan_ready_needs_review")
    return { ...record };
  const trail = auditLedger.getScanAuditTrail(record.scanId);
  return {
    ...record,
    score: calculateReelScanScore(trail.findings).score,
    recommendation: recommendReelScanAction(trail.findings).action
  };
}

export function listInboundRequestsForManager(
  store: PublicIntakeStore,
  auditLedger: AuditLedgerService,
  limit = 200
): InboundRequestManagerView[] {
  return store
    .listRequests(limit)
    .map((record) => summarizeInboundRequestForManager(record, auditLedger));
}
