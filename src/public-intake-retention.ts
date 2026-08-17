// Retention cleanup for public ReelScan inbound requests — an owner
// decision, not an engineering default: an opted-in public-intake request
// record becomes deletion-eligible once it reaches PUBLIC_INTAKE_RETENTION_
// DAYS old, and is actually removed by the next daily retention cleanup
// pass (RETENTION_CLEANUP_CRON in public-intake-config.ts) — not
// necessarily at the exact instant it turns 90 days old. If a business
// later becomes a customer, information genuinely needed for that
// relationship is handled separately under its own future retention rules
// — the original public-intake record does not need to remain
// indefinitely.
//
// Mirrors the storage-agnostic Store + Service architecture used throughout
// this codebase (audit-ledger.ts, public-intake-store.ts): all decision
// logic here is deliberately DI'd and fully testable without a Durable
// Object. sales-agent.ts's onStart()/runInboundRetentionCleanup() are thin
// wrappers around this, exactly like processInboundScanQueue() wraps
// PublicIntakeService.processQueue().
import type { AuditLedgerService } from "./audit-ledger";
import {
  PRE_TURNSTILE_ATTEMPT_LIMIT,
  PUBLIC_INTAKE_RETENTION_DAYS,
  PUBLIC_RATE_LIMIT,
  RETENTION_CLEANUP_CRON
} from "./public-intake-config";
import type { PublicIntakeStore } from "./public-intake-store";

const RETENTION_MS = PUBLIC_INTAKE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Exact millisecond arithmetic — never approximate "N months back" logic,
 * which would drift depending on which months are involved. Based on
 * created_at ONLY (never updated_at): an internal scan/status change must
 * not silently extend how long the underlying request record survives.
 */
export function computeRetentionCutoffIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) - RETENTION_MS).toISOString();
}

/**
 * True once a request's age is >= PUBLIC_INTAKE_RETENTION_DAYS — i.e. it
 * has become deletion-eligible, deliberately inclusive of the exact
 * boundary (a request created exactly 90 days before `now` is eligible,
 * not kept for one more day). Eligibility is instantaneous and exact;
 * actual deletion is not — it happens whenever the next daily cleanup
 * pass runs (see RETENTION_CLEANUP_CRON), which this function has no
 * opinion about.
 */
export function isRequestExpired(createdAtIso: string, nowIso: string): boolean {
  return Date.parse(createdAtIso) <= Date.parse(computeRetentionCutoffIso(nowIso));
}

export interface RetentionCleanupResult {
  deletedRequests: number;
  deletedScanTrails: number;
  /** True when this pass's batch limit was reached — more expired rows may remain for the next scheduled run to continue. */
  moreRemaining: boolean;
}

// -- Privacy-safe operational status (aggregate counts only — see §8) -----

export interface RetentionStatusRecord {
  lastCleanupAt: string | null;
  lastDeletedRequests: number;
  lastDeletedScanTrails: number;
}

const EMPTY_STATUS: RetentionStatusRecord = {
  lastCleanupAt: null,
  lastDeletedRequests: 0,
  lastDeletedScanTrails: 0
};

export interface RetentionStatusStore {
  getStatus(): RetentionStatusRecord;
  recordCleanup(
    nowIso: string,
    deletedRequests: number,
    deletedScanTrails: number
  ): void;
}

// Deliberately NOT a personal deletion log (§8): only ever holds the single
// most recent aggregate cleanup outcome — never names, emails, WhatsApp
// numbers, URLs, issue text, or deleted request IDs. Each recordCleanup()
// call overwrites the previous snapshot rather than appending a history.
export class InMemoryRetentionStatusStore implements RetentionStatusStore {
  private status: RetentionStatusRecord = { ...EMPTY_STATUS };

  getStatus(): RetentionStatusRecord {
    return { ...this.status };
  }

  recordCleanup(
    nowIso: string,
    deletedRequests: number,
    deletedScanTrails: number
  ): void {
    this.status = {
      lastCleanupAt: nowIso,
      lastDeletedRequests: deletedRequests,
      lastDeletedScanTrails: deletedScanTrails
    };
  }
}

export interface RetentionSqlExecutor {
  exec<
    T extends Record<string, ArrayBuffer | string | number | null> = Record<
      string,
      ArrayBuffer | string | number | null
    >
  >(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

export class SqlRetentionStatusStore implements RetentionStatusStore {
  constructor(private readonly sql: RetentionSqlExecutor) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // Single-row table (id fixed to 1) — this is a snapshot, not a log; see
    // the class-level doc comment on InMemoryRetentionStatusStore above.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS retention_cleanup_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_cleanup_at TEXT,
        last_deleted_requests INTEGER NOT NULL DEFAULT 0,
        last_deleted_scan_trails INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  getStatus(): RetentionStatusRecord {
    const row = this.sql
      .exec<{
        last_cleanup_at: string | null;
        last_deleted_requests: number;
        last_deleted_scan_trails: number;
      }>(
        `SELECT last_cleanup_at, last_deleted_requests, last_deleted_scan_trails
         FROM retention_cleanup_status WHERE id = 1`
      )
      .toArray()[0];
    if (!row) return { ...EMPTY_STATUS };
    return {
      lastCleanupAt: row.last_cleanup_at ? String(row.last_cleanup_at) : null,
      lastDeletedRequests: Number(row.last_deleted_requests || 0),
      lastDeletedScanTrails: Number(row.last_deleted_scan_trails || 0)
    };
  }

  recordCleanup(
    nowIso: string,
    deletedRequests: number,
    deletedScanTrails: number
  ): void {
    this.sql.exec(
      `INSERT INTO retention_cleanup_status
         (id, last_cleanup_at, last_deleted_requests, last_deleted_scan_trails)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_cleanup_at = excluded.last_cleanup_at,
         last_deleted_requests = excluded.last_deleted_requests,
         last_deleted_scan_trails = excluded.last_deleted_scan_trails`,
      nowIso,
      deletedRequests,
      deletedScanTrails
    );
  }
}

// -- Cleanup service --------------------------------------------------------

export interface RetentionCleanupDeps {
  store: PublicIntakeStore;
  auditLedger: AuditLedgerService;
  statusStore: RetentionStatusStore;
}

export class PublicIntakeRetentionService {
  constructor(private readonly deps: RetentionCleanupDeps) {}

  /**
   * Deterministic, bounded, safe to call repeatedly (idempotent past the
   * point a row is actually deleted — a second call against the same now
   * either finds fresh work or none). No AI calls, no external fetches, no
   * outreach, no customer notifications — this is pure storage cleanup.
   *
   * For every expired request (any status — a broken/stuck request is not
   * exempt, see §5):
   *   1. delete the request row itself (every personal field on it)
   *   2. if it carried a scanId, check whether ANY remaining request still
   *      references that exact scanId (a scan result can be reused across
   *      multiple requests — see normalizeScanReuseKey in
   *      public-intake-service.ts)
   *   3. only once nothing references it anymore, delete that scan's
   *      public-intake audit trail (evidence/analysis runs/findings/review
   *      events) — never Client #0's or any other unrelated trail, since
   *      this only ever acts on a scanId taken from an expired
   *      inbound_requests row in the first place.
   *
   * Also purges stale public_rate_limit_windows rows (both the accepted-
   * request and pre-Turnstile verification-attempt namespaces) on this
   * same pass — see the inline comment further down for why a caller who
   * never gets past Turnstile needs this, not just deleted requests.
   */
  cleanup(nowIso: string, batchLimit: number): RetentionCleanupResult {
    const { store, auditLedger, statusStore } = this.deps;
    const cutoffIso = computeRetentionCutoffIso(nowIso);
    const expired = store.listExpiredRequests(cutoffIso, batchLimit);

    let deletedRequests = 0;
    let deletedScanTrails = 0;

    for (const candidate of expired) {
      store.deleteRequest(candidate.id);
      deletedRequests++;

      if (candidate.scanId) {
        const stillReferenced =
          store.countRequestsReferencingScan(candidate.scanId) > 0;
        if (!stillReferenced) {
          auditLedger.deleteScanAuditTrail(candidate.scanId);
          deletedScanTrails++;
        }
      }
    }

    // A full batch means there may be more expired rows beyond this pass's
    // limit — not a guarantee (there could be exactly batchLimit and no
    // more), but the safe/conservative direction: it costs one extra,
    // cheap "found nothing" pass rather than silently leaving a backlog
    // unprocessed until tomorrow's cron tick.
    const moreRemaining = expired.length === batchLimit;

    // Rate-limit storage hygiene: purge stale public_rate_limit_windows
    // rows on the SAME daily pass (no separate per-request schedule). The
    // only other purge call site — PublicIntakeService.submit() — only
    // runs on an ACCEPTED submission, so a caller who never gets past
    // Turnstile (or never submits again) would otherwise leave its
    // pseudonymous caller-key row (both the accepted-request window and
    // the pre-Turnstile verify-attempt window share this table) sitting
    // forever. purgeStaleRateLimitWindows() does not distinguish key
    // namespaces, so one call purges rows from both PUBLIC_RATE_LIMIT's
    // and PRE_TURNSTILE_ATTEMPT_LIMIT's windows. Math.max guards against
    // the two ever diverging in the future: using the LARGER window's
    // cutoff never prematurely purges a row still within the other
    // window's legitimate lifetime. No raw IP is stored here (the key is
    // already the pseudonymous, peppered hash from hashCallerKey — see
    // caller-key.ts) and nothing about a purged key is logged or recorded.
    const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);
    const rateLimitWindowSeconds = Math.max(
      PUBLIC_RATE_LIMIT.windowSeconds,
      PRE_TURNSTILE_ATTEMPT_LIMIT.windowSeconds
    );
    store.purgeStaleRateLimitWindows(nowSeconds, rateLimitWindowSeconds);

    statusStore.recordCleanup(nowIso, deletedRequests, deletedScanTrails);
    return { deletedRequests, deletedScanTrails, moreRemaining };
  }
}

// -- Daily schedule setup (idempotent by construction) -----------------

/**
 * The exact, narrow shape sales-agent.ts's onStart() calls this with — a
 * closure over the real Agent.schedule(), never the full Agent instance,
 * so this stays trivially unit-testable with a fake scheduler (see
 * public-intake-retention.test.ts) instead of needing a real Durable
 * Object. Cron schedules are idempotent-by-default in the installed agents
 * SDK (v0.17.4) — deduped by callback+cron+payload — but idempotent:true is
 * passed explicitly anyway, matching this codebase's existing convention
 * (see sales-agent.ts's scheduleInboundScanQueue) of never relying on an
 * unstated default for a call made from onStart(), which runs on every
 * Durable Object wake.
 */
export type ScheduleRetentionCleanupFn = (
  when: string,
  callback: "runInboundRetentionCleanup",
  payload: undefined,
  options: { idempotent: true }
) => Promise<unknown>;

export async function ensureRetentionCleanupSchedule(
  schedule: ScheduleRetentionCleanupFn
): Promise<void> {
  await schedule(RETENTION_CLEANUP_CRON, "runInboundRetentionCleanup", undefined, {
    idempotent: true
  });
}
