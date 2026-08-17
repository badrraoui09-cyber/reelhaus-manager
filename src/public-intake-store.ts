// Storage for inbound public ReelScan requests — an opted-in customer
// asking for a scan, NOT a Discovery prospect, NOT a lead, NOT a CRM
// record. Deliberately its own table, isolated from discovery_candidates/
// leads/drafts: nothing here auto-creates any of those. Mirrors
// audit-ledger.ts's architecture (storage-agnostic Store interface,
// InMemory + Sql implementations, a Service wrapping the business rules)
// for the same reason: the validation/state-transition logic is fully
// testable without a Durable Object.
import type { IntakeLanguage, SupportNeed } from "./public-request-schema";
import type { SubmittedLinkKind } from "./link-classifier";

export const REQUEST_STATUSES = [
  "received",
  "needs_target_review",
  "queued_for_scan",
  "scanning",
  "scan_ready_needs_review",
  "analysis_failed"
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface InboundRequestRecord {
  id: string;
  createdAt: string;
  updatedAt: string;

  name: string;
  businessName: string;
  city: string;
  supportNeed: SupportNeed;
  email?: string;
  whatsapp?: string;
  submittedLink?: string;
  linkKind: SubmittedLinkKind;
  /**
   * Hostname-level normalization of submittedLink, only set for linkKind
   * "website" — see normalizeScanTargetKey(). This is the ABUSE/COST
   * cooldown identity (coarse on purpose: example.com/menu and
   * example.com/contact share it), used for the failed-scan retry
   * backoff. It is deliberately too coarse to reuse an actual scan
   * result across different pages of the same host — see scanReuseKey.
   */
  scanTargetKey?: string;
  /**
   * Exact normalized target URL (fragment stripped only — path/query are
   * never rewritten), only set for linkKind "website" — see
   * normalizeScanReuseKey(). This is the SCAN-RESULT identity: a
   * completed scan is only reused for a new request when both share this
   * exact key, and a duplicate concurrent scan is only skipped when both
   * share this exact key. ReelScan v1 scans one specific submitted page,
   * so reuse coarser than this would silently hand back the wrong page's
   * result.
   */
  scanReuseKey?: string;
  issue?: string;
  language: IntakeLanguage;

  requestStatus: RequestStatus;
  scanId?: string;
  scanStatus?: "completed" | "failed";
  analysisErrorCode?: string;
  /** When a scan for THIS row actually completed — the basis for the 24h reuse freshness window, never createdAt. */
  scanCompletedAt?: string;
  /** When a scan for THIS row actually failed — the basis for the short retry backoff, never createdAt. */
  scanFailedAt?: string;

  sourceOrigin?: string;
  /** When the customer accepted the privacy notice — request context, not a raw consent log. */
  privacyAcceptedAt: string;
}

export interface RateLimitWindowRecord {
  count: number;
  windowStartSeconds: number;
}

export interface PublicIntakeStore {
  insertRequest(record: InboundRequestRecord): void;
  getRequest(id: string): InboundRequestRecord | null;
  listRequests(limit: number): InboundRequestRecord[];
  updateRequestStatus(
    id: string,
    patch: Partial<
      Pick<
        InboundRequestRecord,
        | "requestStatus"
        | "scanId"
        | "scanStatus"
        | "analysisErrorCode"
        | "scanCompletedAt"
        | "scanFailedAt"
      >
    > & { updatedAt: string }
  ): void;

  /**
   * Atomically checks the concurrency cap and, if a slot is available,
   * reserves it by moving the row to "scanning" in the same operation —
   * no separate read-then-write the caller could race against.
   */
  tryReserveScanningSlot(
    id: string,
    nowIso: string,
    maxConcurrent: number,
    maxAgeMs: number
  ): boolean;

  /**
   * Recovers "scanning" rows whose updated_at is older than maxAgeMs back
   * to "queued_for_scan" (a Worker interruption between reserving a slot
   * and reaching a terminal status must not leave a row permanently
   * displayed as "Scanning"). Must be atomic/idempotent: re-running it
   * against already-recovered or genuinely-active rows is a no-op — see
   * public-intake-store.test.ts.
   */
  recoverStaleScanningRows(nowIso: string, maxAgeMs: number): void;

  /**
   * Whether any (non-stale) "scanning" row exists, anywhere — not scoped
   * to a target. Task #5A-fix round 4 §2: a row can be freshly "scanning"
   * (from a scheduled callback that started it but was then interrupted/
   * reset before reaching a terminal status) while listQueuedForScan()
   * is empty. That row is genuine unresolved work — it isn't stale enough
   * for recoverStaleScanningRows() to touch yet, but a future pass still
   * needs to exist to eventually recover it if it never completes.
   * processQueue() ORs this into its "does the caller need to re-arm a
   * future pass" decision so that scenario is never silently dropped.
   */
  hasActiveScanningWork(nowIso: string, maxAgeMs: number): boolean;

  /** Oldest-first, bounded — the intake queue's work list for one pass. */
  listQueuedForScan(limit: number): InboundRequestRecord[];

  /**
   * The most recent SUCCESSFULLY completed scan for an exact scanReuseKey,
   * if any — used to reuse a fresh result instead of re-scanning the
   * identical page. completedAt reflects scan_completed_at (when the scan
   * itself finished), never createdAt (when the request arrived).
   */
  latestCompletedScanForTarget(
    scanReuseKey: string
  ): { scanId: string; completedAt: string } | null;

  /**
   * When the most recent FAILED scan for a (hostname-level) cooldown
   * target happened, if any — a much shorter backoff than the success
   * cooldown. Reflects scan_failed_at, never createdAt.
   */
  latestFailedScanAtForTarget(scanTargetKey: string): string | null;

  /** Whether a (non-stale) scan is currently in flight for this exact scanReuseKey — used to avoid launching a duplicate concurrent scan of the same URL. */
  isTargetCurrentlyScanning(
    scanReuseKey: string,
    nowIso: string,
    maxAgeMs: number
  ): boolean;

  getRateLimitWindow(key: string): RateLimitWindowRecord | null;
  /** Atomically increments-or-starts the window for `key` in one operation. */
  touchRateLimitWindow(
    key: string,
    nowSeconds: number,
    windowSeconds: number
  ): void;
  purgeStaleRateLimitWindows(nowSeconds: number, windowSeconds: number): void;

  /**
   * Retention (see public-intake-retention.ts): oldest-first, bounded list
   * of requests whose created_at is at-or-before cutoffIso — deliberately
   * created_at, never updated_at, so an internal status change can't
   * silently extend how long a row survives. Every request status is
   * eligible, including stuck/broken ones (queued_for_scan, scanning,
   * analysis_failed, needs_target_review) — a broken request must not
   * become immortal just because it never reached a "normal" terminal
   * state. Returns only what deletion needs: the id, and the scanId (if
   * any) so the caller can check reference-safety before touching the
   * scan's audit trail.
   */
  listExpiredRequests(
    cutoffIso: string,
    limit: number
  ): { id: string; scanId?: string }[];

  /** Retention: permanently removes the request row (and every personal field on it) from storage. */
  deleteRequest(id: string): void;

  /**
   * Retention reference-safety: how many inbound_requests rows (across ALL
   * statuses, not just completed ones) still reference this scanId. A scan
   * result can be reused across multiple requests (see
   * normalizeScanReuseKey) — the caller must only delete a scan's audit
   * trail once this returns 0, i.e. after the LAST referencing request has
   * itself been deleted.
   */
  countRequestsReferencingScan(scanId: string): number;
}

export class InMemoryPublicIntakeStore implements PublicIntakeStore {
  private readonly requests = new Map<string, InboundRequestRecord>();
  private readonly rateLimitWindows = new Map<string, RateLimitWindowRecord>();

  insertRequest(record: InboundRequestRecord): void {
    this.requests.set(record.id, record);
  }

  getRequest(id: string): InboundRequestRecord | null {
    return this.requests.get(id) || null;
  }

  listRequests(limit: number): InboundRequestRecord[] {
    return [...this.requests.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  updateRequestStatus(
    id: string,
    patch: Partial<
      Pick<
        InboundRequestRecord,
        | "requestStatus"
        | "scanId"
        | "scanStatus"
        | "analysisErrorCode"
        | "scanCompletedAt"
        | "scanFailedAt"
      >
    > & { updatedAt: string }
  ): void {
    const current = this.requests.get(id);
    if (!current) return;
    this.requests.set(id, { ...current, ...patch });
  }

  tryReserveScanningSlot(
    id: string,
    nowIso: string,
    maxConcurrent: number,
    maxAgeMs: number
  ): boolean {
    const nowMs = Date.parse(nowIso);
    const activeCount = [...this.requests.values()].filter(
      (record) =>
        record.requestStatus === "scanning" &&
        nowMs - Date.parse(record.updatedAt) <= maxAgeMs
    ).length;
    if (activeCount >= maxConcurrent) return false;
    this.updateRequestStatus(id, { requestStatus: "scanning", updatedAt: nowIso });
    return true;
  }

  recoverStaleScanningRows(nowIso: string, maxAgeMs: number): void {
    const nowMs = Date.parse(nowIso);
    for (const record of this.requests.values()) {
      if (
        record.requestStatus === "scanning" &&
        nowMs - Date.parse(record.updatedAt) > maxAgeMs
      ) {
        this.requests.set(record.id, {
          ...record,
          requestStatus: "queued_for_scan",
          scanId: undefined,
          scanStatus: undefined,
          analysisErrorCode: undefined,
          updatedAt: nowIso
        });
      }
    }
  }

  hasActiveScanningWork(nowIso: string, maxAgeMs: number): boolean {
    const nowMs = Date.parse(nowIso);
    return [...this.requests.values()].some(
      (record) =>
        record.requestStatus === "scanning" &&
        nowMs - Date.parse(record.updatedAt) <= maxAgeMs
    );
  }

  listQueuedForScan(limit: number): InboundRequestRecord[] {
    return [...this.requests.values()]
      .filter((record) => record.requestStatus === "queued_for_scan")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  latestCompletedScanForTarget(
    scanReuseKey: string
  ): { scanId: string; completedAt: string } | null {
    const matches = [...this.requests.values()]
      .filter(
        (record) =>
          record.scanReuseKey === scanReuseKey &&
          record.requestStatus === "scan_ready_needs_review" &&
          record.scanId &&
          record.scanCompletedAt
      )
      .sort((a, b) => b.scanCompletedAt!.localeCompare(a.scanCompletedAt!));
    const match = matches[0];
    return match
      ? { scanId: match.scanId!, completedAt: match.scanCompletedAt! }
      : null;
  }

  latestFailedScanAtForTarget(scanTargetKey: string): string | null {
    const matches = [...this.requests.values()]
      .filter(
        (record) =>
          record.scanTargetKey === scanTargetKey &&
          record.requestStatus === "analysis_failed" &&
          record.scanFailedAt
      )
      .sort((a, b) => b.scanFailedAt!.localeCompare(a.scanFailedAt!));
    return matches[0]?.scanFailedAt || null;
  }

  isTargetCurrentlyScanning(
    scanReuseKey: string,
    nowIso: string,
    maxAgeMs: number
  ): boolean {
    const nowMs = Date.parse(nowIso);
    return [...this.requests.values()].some(
      (record) =>
        record.scanReuseKey === scanReuseKey &&
        record.requestStatus === "scanning" &&
        nowMs - Date.parse(record.updatedAt) <= maxAgeMs
    );
  }

  getRateLimitWindow(key: string): RateLimitWindowRecord | null {
    return this.rateLimitWindows.get(key) || null;
  }

  touchRateLimitWindow(
    key: string,
    nowSeconds: number,
    windowSeconds: number
  ): void {
    const current = this.rateLimitWindows.get(key);
    if (!current || nowSeconds - current.windowStartSeconds >= windowSeconds) {
      this.rateLimitWindows.set(key, { count: 1, windowStartSeconds: nowSeconds });
      return;
    }
    this.rateLimitWindows.set(key, {
      count: current.count + 1,
      windowStartSeconds: current.windowStartSeconds
    });
  }

  purgeStaleRateLimitWindows(nowSeconds: number, windowSeconds: number): void {
    for (const [key, window] of this.rateLimitWindows.entries())
      if (nowSeconds - window.windowStartSeconds >= windowSeconds * 2)
        this.rateLimitWindows.delete(key);
  }

  listExpiredRequests(
    cutoffIso: string,
    limit: number
  ): { id: string; scanId?: string }[] {
    const cutoffMs = Date.parse(cutoffIso);
    return [...this.requests.values()]
      .filter((record) => Date.parse(record.createdAt) <= cutoffMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((record) => ({ id: record.id, scanId: record.scanId }));
  }

  deleteRequest(id: string): void {
    this.requests.delete(id);
  }

  countRequestsReferencingScan(scanId: string): number {
    return [...this.requests.values()].filter(
      (record) => record.scanId === scanId
    ).length;
  }
}

// Re-declared with the exact same shape audit-ledger.ts uses (not imported
// from it) to keep this module's storage contract independent — but the
// constraint below matters: it must match Cloudflare's real
// SqlStorage.exec<T extends Record<string, SqlStorageValue>> or
// `this.ctx.storage.sql` won't satisfy this interface structurally.
export interface SqlExecutor {
  exec<T extends Record<string, ArrayBuffer | string | number | null> = Record<
    string,
    ArrayBuffer | string | number | null
  >>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

type SqlRow = Record<string, ArrayBuffer | string | number | null>;

function mapRequestRow(row: SqlRow): InboundRequestRecord {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    name: String(row.name),
    businessName: String(row.business_name),
    city: String(row.city),
    supportNeed: String(row.support_need) as SupportNeed,
    email: row.email ? String(row.email) : undefined,
    whatsapp: row.whatsapp ? String(row.whatsapp) : undefined,
    submittedLink: row.submitted_link ? String(row.submitted_link) : undefined,
    linkKind: String(row.link_kind) as SubmittedLinkKind,
    scanTargetKey: row.scan_target_key ? String(row.scan_target_key) : undefined,
    scanReuseKey: row.scan_reuse_key ? String(row.scan_reuse_key) : undefined,
    issue: row.issue ? String(row.issue) : undefined,
    language: String(row.language) as IntakeLanguage,
    requestStatus: String(row.request_status) as RequestStatus,
    scanId: row.scan_id ? String(row.scan_id) : undefined,
    scanStatus: row.scan_status
      ? (String(row.scan_status) as "completed" | "failed")
      : undefined,
    analysisErrorCode: row.analysis_error_code
      ? String(row.analysis_error_code)
      : undefined,
    scanCompletedAt: row.scan_completed_at ? String(row.scan_completed_at) : undefined,
    scanFailedAt: row.scan_failed_at ? String(row.scan_failed_at) : undefined,
    sourceOrigin: row.source_origin ? String(row.source_origin) : undefined,
    privacyAcceptedAt: String(row.privacy_accepted_at)
  };
}

export class SqlPublicIntakeStore implements PublicIntakeStore {
  constructor(private readonly sql: SqlExecutor) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS inbound_requests (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        name TEXT NOT NULL, business_name TEXT NOT NULL, city TEXT NOT NULL,
        support_need TEXT NOT NULL, email TEXT, whatsapp TEXT,
        submitted_link TEXT, link_kind TEXT NOT NULL, scan_target_key TEXT,
        issue TEXT, language TEXT NOT NULL,
        request_status TEXT NOT NULL, scan_id TEXT, scan_status TEXT,
        analysis_error_code TEXT,
        source_origin TEXT, privacy_accepted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public_rate_limit_windows (
        key TEXT PRIMARY KEY, count INTEGER NOT NULL,
        window_start_seconds INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbound_requests_created
        ON inbound_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS inbound_requests_status_updated
        ON inbound_requests(request_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS inbound_requests_target
        ON inbound_requests(scan_target_key, created_at DESC);
    `);
    // Additive/idempotent migration for an already-deployed table — see
    // sales-agent.ts's ensureDiscoveryColumn() for the same pattern.
    // scan_reuse_key: the exact-URL scan-result identity (Task #5A-fix
    // round 3 §3), separate from the coarser hostname-level
    // scan_target_key abuse/cost cooldown. scan_completed_at/
    // scan_failed_at: when THIS row's own scan actually finished/failed,
    // never createdAt (§4).
    this.ensureColumn("scan_reuse_key", "TEXT");
    this.ensureColumn("scan_completed_at", "TEXT");
    this.ensureColumn("scan_failed_at", "TEXT");
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS inbound_requests_reuse
        ON inbound_requests(scan_reuse_key, scan_completed_at DESC);
    `);
  }

  private ensureColumn(column: string, definition: string): void {
    const exists = this.sql
      .exec<{ name: string }>("PRAGMA table_info(inbound_requests)")
      .toArray()
      .some((item) => item.name === column);
    if (!exists)
      this.sql.exec(`ALTER TABLE inbound_requests ADD COLUMN ${column} ${definition}`);
  }

  insertRequest(record: InboundRequestRecord): void {
    this.sql.exec(
      `INSERT INTO inbound_requests (
        id, created_at, updated_at, name, business_name, city, support_need,
        email, whatsapp, submitted_link, link_kind, scan_target_key,
        scan_reuse_key, issue,
        language, request_status, scan_id, scan_status, analysis_error_code,
        scan_completed_at, scan_failed_at,
        source_origin, privacy_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.createdAt,
      record.updatedAt,
      record.name,
      record.businessName,
      record.city,
      record.supportNeed,
      record.email ?? null,
      record.whatsapp ?? null,
      record.submittedLink ?? null,
      record.linkKind,
      record.scanTargetKey ?? null,
      record.scanReuseKey ?? null,
      record.issue ?? null,
      record.language,
      record.requestStatus,
      record.scanId ?? null,
      record.scanStatus ?? null,
      record.analysisErrorCode ?? null,
      record.scanCompletedAt ?? null,
      record.scanFailedAt ?? null,
      record.sourceOrigin ?? null,
      record.privacyAcceptedAt
    );
  }

  getRequest(id: string): InboundRequestRecord | null {
    const row = this.sql
      .exec<SqlRow>("SELECT * FROM inbound_requests WHERE id = ?", id)
      .toArray()[0];
    return row ? mapRequestRow(row) : null;
  }

  listRequests(limit: number): InboundRequestRecord[] {
    return this.sql
      .exec<SqlRow>(
        "SELECT * FROM inbound_requests ORDER BY created_at DESC LIMIT ?",
        limit
      )
      .toArray()
      .map(mapRequestRow);
  }

  updateRequestStatus(
    id: string,
    patch: Partial<
      Pick<
        InboundRequestRecord,
        | "requestStatus"
        | "scanId"
        | "scanStatus"
        | "analysisErrorCode"
        | "scanCompletedAt"
        | "scanFailedAt"
      >
    > & { updatedAt: string }
  ): void {
    const current = this.getRequest(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.sql.exec(
      `UPDATE inbound_requests SET
        request_status = ?, scan_id = ?, scan_status = ?,
        analysis_error_code = ?, scan_completed_at = ?, scan_failed_at = ?,
        updated_at = ?
      WHERE id = ?`,
      next.requestStatus,
      next.scanId ?? null,
      next.scanStatus ?? null,
      next.analysisErrorCode ?? null,
      next.scanCompletedAt ?? null,
      next.scanFailedAt ?? null,
      next.updatedAt,
      id
    );
  }

  tryReserveScanningSlot(
    id: string,
    nowIso: string,
    maxConcurrent: number,
    maxAgeMs: number
  ): boolean {
    // No `await` occurs between this read and the write below — Durable
    // Object SQLite calls are synchronous, so nothing else can interleave
    // between the count check and the reservation. This is the "single
    // Durable Object / SQLite transaction" the check + reserve needs.
    const cutoffIso = new Date(Date.parse(nowIso) - maxAgeMs).toISOString();
    const active = this.sql
      .exec<{ active: number }>(
        "SELECT COUNT(*) AS active FROM inbound_requests WHERE request_status = 'scanning' AND updated_at > ?",
        cutoffIso
      )
      .toArray()[0];
    if (Number(active?.active || 0) >= maxConcurrent) return false;
    this.updateRequestStatus(id, { requestStatus: "scanning", updatedAt: nowIso });
    return true;
  }

  recoverStaleScanningRows(nowIso: string, maxAgeMs: number): void {
    // A single bulk UPDATE — atomic, and idempotent by construction: once
    // a row's status is no longer 'scanning' it can never match this
    // WHERE clause again, so re-running this against the same rows (an
    // at-least-once scheduled callback re-delivery) is a safe no-op.
    // Never touches a fresh (non-stale) "scanning" row.
    const cutoffIso = new Date(Date.parse(nowIso) - maxAgeMs).toISOString();
    this.sql.exec(
      `UPDATE inbound_requests SET
        request_status = 'queued_for_scan', scan_id = NULL, scan_status = NULL,
        analysis_error_code = NULL, updated_at = ?
      WHERE request_status = 'scanning' AND updated_at <= ?`,
      nowIso,
      cutoffIso
    );
  }

  hasActiveScanningWork(nowIso: string, maxAgeMs: number): boolean {
    const cutoffIso = new Date(Date.parse(nowIso) - maxAgeMs).toISOString();
    const row = this.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM inbound_requests
         WHERE request_status = 'scanning' AND updated_at > ?
         LIMIT 1`,
        cutoffIso
      )
      .toArray()[0];
    return Boolean(row);
  }

  listQueuedForScan(limit: number): InboundRequestRecord[] {
    return this.sql
      .exec<SqlRow>(
        `SELECT * FROM inbound_requests WHERE request_status = 'queued_for_scan'
         ORDER BY created_at ASC LIMIT ?`,
        limit
      )
      .toArray()
      .map(mapRequestRow);
  }

  latestCompletedScanForTarget(
    scanReuseKey: string
  ): { scanId: string; completedAt: string } | null {
    const row = this.sql
      .exec<{ scan_id: string; scan_completed_at: string }>(
        `SELECT scan_id, scan_completed_at FROM inbound_requests
         WHERE scan_reuse_key = ? AND request_status = 'scan_ready_needs_review'
           AND scan_id IS NOT NULL AND scan_completed_at IS NOT NULL
         ORDER BY scan_completed_at DESC LIMIT 1`,
        scanReuseKey
      )
      .toArray()[0];
    return row ? { scanId: row.scan_id, completedAt: row.scan_completed_at } : null;
  }

  latestFailedScanAtForTarget(scanTargetKey: string): string | null {
    const row = this.sql
      .exec<{ scan_failed_at: string }>(
        `SELECT scan_failed_at FROM inbound_requests
         WHERE scan_target_key = ? AND request_status = 'analysis_failed'
           AND scan_failed_at IS NOT NULL
         ORDER BY scan_failed_at DESC LIMIT 1`,
        scanTargetKey
      )
      .toArray()[0];
    return row ? row.scan_failed_at : null;
  }

  isTargetCurrentlyScanning(
    scanReuseKey: string,
    nowIso: string,
    maxAgeMs: number
  ): boolean {
    const cutoffIso = new Date(Date.parse(nowIso) - maxAgeMs).toISOString();
    const row = this.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM inbound_requests
         WHERE scan_reuse_key = ? AND request_status = 'scanning' AND updated_at > ?
         LIMIT 1`,
        scanReuseKey,
        cutoffIso
      )
      .toArray()[0];
    return Boolean(row);
  }

  getRateLimitWindow(key: string): RateLimitWindowRecord | null {
    const row = this.sql
      .exec<{ count: number; window_start_seconds: number }>(
        "SELECT count, window_start_seconds FROM public_rate_limit_windows WHERE key = ?",
        key
      )
      .toArray()[0];
    return row
      ? { count: Number(row.count), windowStartSeconds: Number(row.window_start_seconds) }
      : null;
  }

  touchRateLimitWindow(
    key: string,
    nowSeconds: number,
    windowSeconds: number
  ): void {
    // Synchronous read-then-write, same atomicity guarantee as
    // tryReserveScanningSlot above.
    const current = this.getRateLimitWindow(key);
    if (!current || nowSeconds - current.windowStartSeconds >= windowSeconds) {
      this.sql.exec(
        `INSERT INTO public_rate_limit_windows (key, count, window_start_seconds)
         VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, window_start_seconds = excluded.window_start_seconds`,
        key,
        nowSeconds
      );
      return;
    }
    this.sql.exec(
      "UPDATE public_rate_limit_windows SET count = count + 1 WHERE key = ?",
      key
    );
  }

  purgeStaleRateLimitWindows(nowSeconds: number, windowSeconds: number): void {
    this.sql.exec(
      "DELETE FROM public_rate_limit_windows WHERE ? - window_start_seconds >= ?",
      nowSeconds,
      windowSeconds * 2
    );
  }

  listExpiredRequests(
    cutoffIso: string,
    limit: number
  ): { id: string; scanId?: string }[] {
    // created_at is an ISO-8601 "Z" string throughout this table, so plain
    // string comparison sorts/filters identically to numeric millisecond
    // comparison — same convention as recoverStaleScanningRows() above.
    return this.sql
      .exec<{ id: string; scan_id: string | null }>(
        `SELECT id, scan_id FROM inbound_requests
         WHERE created_at <= ? ORDER BY created_at ASC LIMIT ?`,
        cutoffIso,
        limit
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        scanId: row.scan_id ? String(row.scan_id) : undefined
      }));
  }

  deleteRequest(id: string): void {
    this.sql.exec("DELETE FROM inbound_requests WHERE id = ?", id);
  }

  countRequestsReferencingScan(scanId: string): number {
    const row = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM inbound_requests WHERE scan_id = ?",
        scanId
      )
      .toArray()[0];
    return Number(row?.count || 0);
  }
}
