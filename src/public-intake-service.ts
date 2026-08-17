// Orchestrates one inbound public ReelScan request: rate-limit, classify
// the optional link, persist, and — only for a safe website target, only
// if not cooled down, only if a concurrency slot is available — run the
// generalized ReelScan pipeline. An inbound request is a customer asking
// for a scan, never auto-converted into a Discovery candidate, a lead, or
// an outreach draft; nothing here touches those tables.
import type { AuditLedgerService } from "./audit-ledger";
import type { WorkersAiBinding } from "./ai-service";
import { classifySubmittedLink } from "./link-classifier";
import {
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

export type PublicIntakeOutcome =
  | { accepted: true; id: string }
  | { accepted: false; reason: "rate_limited" | "invalid_request" };

export interface PublicIntakeDeps {
  store: PublicIntakeStore;
  auditLedger: AuditLedgerService;
  ai: WorkersAiBinding | undefined;
  fetcher: typeof fetch;
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
      issue: input.issue,
      language: input.language,
      requestStatus: link.kind === "website" ? "received" : "needs_target_review",
      sourceOrigin: sourceOrigin || undefined,
      privacyAcceptedAt: nowIso
    };
    store.insertRequest(record);

    // No scannable website — a legitimate business without a site is not
    // rejected, it simply needs a human to decide what happens next.
    if (link.kind !== "website" || !link.normalizedUrl) return { accepted: true, id };

    if (scanTargetKey) {
      const lastScanAt = store.lastScanAtForTarget(scanTargetKey);
      const cooldown = evaluateTargetCooldown(lastScanAt, nowMs, TARGET_SCAN_COOLDOWN_MS);
      // Accepted either way — just not (re-)scanned right now. The request
      // stays "received"; nothing is lost, nothing is rejected.
      if (!cooldown.allowed) return { accepted: true, id };
    }

    const reserved = store.tryReserveScanningSlot(
      id,
      nowIso,
      MAX_CONCURRENT_PUBLIC_SCANS,
      SCAN_RESERVATION_MAX_AGE_MS
    );
    // Capacity is full right now — accepted, deferred, stays "received".
    // No background retry queue exists in Task #5A; a human can act on it
    // via the Manager, or a later task can add automatic retry.
    if (!reserved) return { accepted: true, id };

    try {
      const result = await runReelScanV1Target({
        targetUrl: link.normalizedUrl,
        ai: this.deps.ai,
        auditLedger: this.deps.auditLedger,
        fetcher: this.deps.fetcher
      });
      const finalStatus: RequestStatus =
        result.reviewStatus === "needs_review"
          ? "scan_ready_needs_review"
          : "analysis_failed";
      store.updateRequestStatus(id, {
        requestStatus: finalStatus,
        scanId: result.scanId,
        scanStatus: result.analysisRun.status === "completed" ? "completed" : "failed",
        analysisErrorCode:
          result.analysisRun.status === "failed"
            ? result.analysisRun.error || "analysis_failed"
            : undefined,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      // Always resolves the reservation — success and failure paths both
      // move the row out of "scanning" so it never counts against the
      // concurrency cap again after this point.
      store.updateRequestStatus(id, {
        requestStatus: "analysis_failed",
        analysisErrorCode:
          error instanceof ReelScanTargetError ? error.reason : "unknown_error",
        updatedAt: new Date().toISOString()
      });
    }

    return { accepted: true, id };
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
