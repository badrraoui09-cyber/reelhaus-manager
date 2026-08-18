// Task #2.19 — ReelFix proof loop, Part A: a lightweight relationship
// between a completed baseline ReelScan and a later completed ReelScan
// that verifies it.
//
// Deliberately additive on top of the existing audit ledger
// (AuditLedgerService / ScanAuditTrail) — this is NOT a second audit
// system. A link only records WHICH scanId verifies WHICH baseline
// scanId; it never duplicates evidence, findings, or scores. The
// before/after comparison itself lives in reelfix-comparison.ts, and the
// customer-facing report in reelfix-proof-report.ts — kept separate so
// each piece stays a small, independently testable, pure(ish) layer, the
// same "layered interpretation" shape the rest of ReelScan already uses
// (reelscan.ts -> reelscan-customer-report.ts -> reelscan-commercial-
// analysis.ts).
//
// Internal only, by construction: nothing in this file is reachable from
// the public intake route. Creating a link requires an Access-protected
// Manager route (see sales-agent.ts's /inbound-requests/:id/reelfix-
// verification, added to server-routing.ts's private API_ROUTES, never
// PUBLIC_API_ROUTES) — never automatic, never customer-facing, and never
// touches Discovery/Lead/Outreach tables.
//
// Keyed by scanId (not by any InboundRequestRecord id) so a link works
// for any completed scan — Client #0, the validation runner, or a public-
// intake customer scan — the same way AuditLedgerService itself is
// decoupled from where a scan came from.
import type { AuditLedgerService, EvidenceRecord } from "./audit-ledger";

export interface ReelFixVerificationLink {
  id: string;
  baselineScanId: string;
  verificationScanId: string;
  createdAt: string;
}

// Stable string reasons, not free text — a caller (the internal Manager
// route) maps these to an HTTP status without parsing a message string.
export type ReelFixVerificationRejectionReason =
  | "scan_cannot_verify_itself"
  | "baseline_scan_not_completed"
  | "verification_scan_not_completed"
  | "target_mismatch"
  | "verification_scan_already_linked";

export class ReelFixVerificationError extends Error {
  constructor(public readonly reason: ReelFixVerificationRejectionReason) {
    super(reason);
  }
}

export interface ReelFixVerificationStore {
  insertLink(link: ReelFixVerificationLink): void;
  getLink(id: string): ReelFixVerificationLink | null;
  listLinksForBaseline(baselineScanId: string): ReelFixVerificationLink[];
  getLinkForVerification(verificationScanId: string): ReelFixVerificationLink | null;
}

export class InMemoryReelFixVerificationStore implements ReelFixVerificationStore {
  private readonly links = new Map<string, ReelFixVerificationLink>();

  insertLink(link: ReelFixVerificationLink): void {
    this.links.set(link.id, link);
  }

  getLink(id: string): ReelFixVerificationLink | null {
    return this.links.get(id) || null;
  }

  listLinksForBaseline(baselineScanId: string): ReelFixVerificationLink[] {
    return [...this.links.values()]
      .filter((link) => link.baselineScanId === baselineScanId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getLinkForVerification(verificationScanId: string): ReelFixVerificationLink | null {
    return (
      [...this.links.values()].find(
        (link) => link.verificationScanId === verificationScanId
      ) || null
    );
  }
}

// Mirrors audit-ledger.ts's / public-intake-store.ts's own SqlExecutor
// shape exactly. Each of those modules already duplicates this tiny
// interface independently rather than sharing it (see public-intake-
// store.ts) so that no two storage-backed modules in this codebase
// depend on each other just to describe "a thing I can run SQL against" —
// this module follows the same, already-established convention.
interface SqlExecutor {
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

type SqlRow = Record<string, ArrayBuffer | string | number | null>;

function mapLinkRow(row: SqlRow): ReelFixVerificationLink {
  return {
    id: String(row.id),
    baselineScanId: String(row.baseline_scan_id),
    verificationScanId: String(row.verification_scan_id),
    createdAt: String(row.created_at)
  };
}

export class SqlReelFixVerificationStore implements ReelFixVerificationStore {
  constructor(private readonly sql: SqlExecutor) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reelfix_verification_links (
        id TEXT PRIMARY KEY,
        baseline_scan_id TEXT NOT NULL,
        verification_scan_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reelfix_verification_links_baseline
        ON reelfix_verification_links(baseline_scan_id, created_at ASC);
    `);
  }

  insertLink(link: ReelFixVerificationLink): void {
    this.sql.exec(
      `INSERT INTO reelfix_verification_links (
        id, baseline_scan_id, verification_scan_id, created_at
      ) VALUES (?, ?, ?, ?)`,
      link.id,
      link.baselineScanId,
      link.verificationScanId,
      link.createdAt
    );
  }

  getLink(id: string): ReelFixVerificationLink | null {
    const row = this.sql
      .exec<SqlRow>("SELECT * FROM reelfix_verification_links WHERE id = ?", id)
      .toArray()[0];
    return row ? mapLinkRow(row) : null;
  }

  listLinksForBaseline(baselineScanId: string): ReelFixVerificationLink[] {
    return this.sql
      .exec<SqlRow>(
        "SELECT * FROM reelfix_verification_links WHERE baseline_scan_id = ? ORDER BY created_at ASC",
        baselineScanId
      )
      .toArray()
      .map(mapLinkRow);
  }

  getLinkForVerification(verificationScanId: string): ReelFixVerificationLink | null {
    const row = this.sql
      .exec<SqlRow>(
        "SELECT * FROM reelfix_verification_links WHERE verification_scan_id = ?",
        verificationScanId
      )
      .toArray()[0];
    return row ? mapLinkRow(row) : null;
  }
}

// -- Validation --------------------------------------------------------------

// Mirrors normalizeScanReuseKey() (public-intake-service.ts) exactly —
// fragment-stripped only, path/query preserved exactly. Deliberately
// duplicated here rather than imported: this module must work for any
// completed scan (Client #0, the validation runner, a public-intake
// customer scan), not only ones that went through the public intake
// queue, so it never depends on public-intake-service.ts.
function canonicalizeTargetUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

// A scan's canonical target identity, derived from its own evidence
// (every EvidenceRecord ReelScan v1 produces for a single-URL target
// carries the exact fetched sourceUrl — see reelscan.ts's
// contentEvidenceInputs()/technicalEvidenceFromGenericFindings()) rather
// than from any InboundRequestRecord field. An empty set (no evidence, or
// no evidence with a sourceUrl) is deliberately never treated as "no
// opinion" — sameTargetIdentity() below fails closed on it.
function scanTargetIdentity(evidence: EvidenceRecord[]): Set<string> {
  const urls = new Set<string>();
  for (const item of evidence)
    if (item.sourceUrl) urls.add(canonicalizeTargetUrl(item.sourceUrl));
  return urls;
}

function sameTargetIdentity(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (!a.size || !b.size) return false;
  if (a.size !== b.size) return false;
  for (const url of a) if (!b.has(url)) return false;
  return true;
}

// A scanId is "completed" when it has at least one AiAnalysisRun that
// finished successfully — the same ledger-level signal
// runReelScanV1Core() itself uses to decide ReelScanV1Result.reviewStatus
// ("needs_review" only after completeAiAnalysisRun(id, {status:
// "completed"})). A scanId with no analysis run at all (never existed, or
// was already deleted by retention — see public-intake-retention.ts) is
// correctly treated as not completed, not as an error.
function isScanCompleted(auditLedger: AuditLedgerService, scanId: string): boolean {
  return auditLedger
    .getScanAuditTrail(scanId)
    .analysisRuns.some((run) => run.status === "completed");
}

export class ReelFixVerificationService {
  constructor(
    private readonly auditLedger: AuditLedgerService,
    private readonly store: ReelFixVerificationStore
  ) {}

  /**
   * Creates the link, or throws ReelFixVerificationError with a stable
   * `.reason` an internal Manager route can map to an HTTP status.
   * Every Task #2.19 Part A requirement is enforced here, once, so "can
   * these two scans be linked" is never re-implemented or silently
   * bypassed anywhere else.
   */
  linkVerification(input: {
    baselineScanId: string;
    verificationScanId: string;
  }): ReelFixVerificationLink {
    const { baselineScanId, verificationScanId } = input;

    if (baselineScanId === verificationScanId)
      throw new ReelFixVerificationError("scan_cannot_verify_itself");

    if (!isScanCompleted(this.auditLedger, baselineScanId))
      throw new ReelFixVerificationError("baseline_scan_not_completed");
    if (!isScanCompleted(this.auditLedger, verificationScanId))
      throw new ReelFixVerificationError("verification_scan_not_completed");

    const baselineTargets = scanTargetIdentity(
      this.auditLedger.getScanAuditTrail(baselineScanId).evidence
    );
    const verificationTargets = scanTargetIdentity(
      this.auditLedger.getScanAuditTrail(verificationScanId).evidence
    );
    if (!sameTargetIdentity(baselineTargets, verificationTargets))
      throw new ReelFixVerificationError("target_mismatch");

    // A verification scan verifies exactly one baseline — prevents an
    // ambiguous "which before-scan does this after-scan actually belong
    // to" situation. A baseline may still have several verifications over
    // time (v1's explicit requirement); only the verification side is
    // unique.
    if (this.store.getLinkForVerification(verificationScanId))
      throw new ReelFixVerificationError("verification_scan_already_linked");

    const link: ReelFixVerificationLink = {
      id: crypto.randomUUID(),
      baselineScanId,
      verificationScanId,
      createdAt: new Date().toISOString()
    };
    this.store.insertLink(link);
    return link;
  }

  /**
   * The most recently linked verification for this baseline, if any —
   * v1's default "unambiguous way to identify the verification being
   * compared" when a caller doesn't name one explicitly (see
   * listVerifications() below for naming one explicitly instead).
   */
  latestVerification(baselineScanId: string): ReelFixVerificationLink | null {
    const links = this.store.listLinksForBaseline(baselineScanId);
    return links.length ? links[links.length - 1] : null;
  }

  listVerifications(baselineScanId: string): ReelFixVerificationLink[] {
    return this.store.listLinksForBaseline(baselineScanId);
  }
}
