// Evidence + audit lineage for future AI-driven ReelScan analysis.
//
// Nothing here calls an AI model or generates findings. It is the traceable
// spine that later ReelScan AI work must write through: every finding has to
// point at evidence that actually exists for the same scan, and every AI
// finding may only cite evidence that was actually handed to its analysis
// run. Human corrections are appended, never overwritten.
//
// Deliberately does not store raw prompt text or raw model responses — only
// a `promptVersion`/`schemaVersion` identifier. Prompts can carry business
// context (and, by mistake, secrets); a version string is enough to diagnose
// "which prompt produced this" without ever persisting that content.
import type { EvidenceConfidence } from "./sales-types";
import type { Severity } from "./website-analysis";

export interface EvidenceRecord {
  id: string;
  scanId: string;
  sourceType: string;
  sourceUrl?: string;
  observationType: string;
  observation: string;
  capturedAt: string;
  collector: string;
  metadata?: Record<string, unknown>;
}

export type AiAnalysisRunStatus = "running" | "completed" | "failed";

export interface AiAnalysisRun {
  id: string;
  scanId: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  startedAt: string;
  completedAt: string | null;
  evidenceIds: string[];
  status: AiAnalysisRunStatus;
  error: string | null;
}

// "note" = a deterministic downgrade of an AI "issue" whose only backing
// evidence was unverified/inferential — preserved for the audit trail but
// never scored. See reelscan.ts downgradeUncertainIssues().
export type FindingKind = "strength" | "issue" | "note";

// Defect severity applies to "issue" findings. A "strength" finding is
// never a defect, so it carries `impact` instead and `severity: null` —
// a persisted `{kind:"strength", severity:"critical"}` would read as a
// critical *problem* to anyone looking at the raw record, which is
// exactly the confusion this separation avoids.
export type FindingImpact = "high" | "medium" | "low";

export interface FindingRecord {
  id: string;
  scanId: string;
  analysisRunId: string | null;
  kind: FindingKind;
  title: string;
  category: string;
  severity: Severity | null;
  impact?: FindingImpact;
  priority: number;
  summary: string;
  evidenceIds: string[];
  confidence?: EvidenceConfidence;
  scoreImpact?: number;
  createdAt: string;
}

export type FindingReviewAction =
  | "accepted"
  | "edited"
  | "severity_changed"
  | "priority_changed"
  | "rejected"
  | "note_added";

export interface FindingReviewEvent {
  id: string;
  findingId: string;
  action: FindingReviewAction;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  reviewer: string;
  createdAt: string;
}

export interface ScanAuditTrail {
  scanId: string;
  evidence: EvidenceRecord[];
  analysisRuns: AiAnalysisRun[];
  findings: FindingRecord[];
  reviewEvents: FindingReviewEvent[];
}

export class AuditLedgerError extends Error {}

export interface AuditLedgerStore {
  insertEvidence(record: EvidenceRecord): void;
  getEvidence(id: string): EvidenceRecord | null;
  listEvidenceByScan(scanId: string): EvidenceRecord[];

  insertAnalysisRun(run: AiAnalysisRun): void;
  getAnalysisRun(id: string): AiAnalysisRun | null;
  updateAnalysisRun(
    id: string,
    patch: Pick<AiAnalysisRun, "status" | "completedAt" | "error">
  ): void;
  listAnalysisRunsByScan(scanId: string): AiAnalysisRun[];

  insertFinding(record: FindingRecord): void;
  getFinding(id: string): FindingRecord | null;
  listFindingsByScan(scanId: string): FindingRecord[];

  insertReviewEvent(event: FindingReviewEvent): void;
  listReviewEventsByScan(scanId: string): FindingReviewEvent[];

  /**
   * Retention (see public-intake-retention.ts): permanently deletes every
   * row of this scan's audit trail, in dependency order — review events
   * first (they reference findings), then findings (they reference
   * analysis runs), then analysis runs, then evidence last. Callers must
   * only invoke this once no inbound_requests row still references
   * scanId — see PublicIntakeStore.countRequestsReferencingScan(). Never
   * called for a scanId that isn't derived from an expired public-intake
   * request (e.g. Client #0's scan trail is never eligible, since it has
   * no corresponding inbound_requests row at all).
   */
  deleteReviewEventsByScan(scanId: string): void;
  deleteFindingsByScan(scanId: string): void;
  deleteAnalysisRunsByScan(scanId: string): void;
  deleteEvidenceByScan(scanId: string): void;
}

export class InMemoryAuditLedgerStore implements AuditLedgerStore {
  private readonly evidence = new Map<string, EvidenceRecord>();
  private readonly analysisRuns = new Map<string, AiAnalysisRun>();
  private readonly findings = new Map<string, FindingRecord>();
  private readonly reviewEvents = new Map<string, FindingReviewEvent>();

  insertEvidence(record: EvidenceRecord): void {
    this.evidence.set(record.id, record);
  }

  getEvidence(id: string): EvidenceRecord | null {
    return this.evidence.get(id) || null;
  }

  listEvidenceByScan(scanId: string): EvidenceRecord[] {
    return [...this.evidence.values()]
      .filter((record) => record.scanId === scanId)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  insertAnalysisRun(run: AiAnalysisRun): void {
    this.analysisRuns.set(run.id, run);
  }

  getAnalysisRun(id: string): AiAnalysisRun | null {
    return this.analysisRuns.get(id) || null;
  }

  updateAnalysisRun(
    id: string,
    patch: Pick<AiAnalysisRun, "status" | "completedAt" | "error">
  ): void {
    const current = this.analysisRuns.get(id);
    if (!current) return;
    this.analysisRuns.set(id, { ...current, ...patch });
  }

  listAnalysisRunsByScan(scanId: string): AiAnalysisRun[] {
    return [...this.analysisRuns.values()]
      .filter((run) => run.scanId === scanId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  insertFinding(record: FindingRecord): void {
    this.findings.set(record.id, record);
  }

  getFinding(id: string): FindingRecord | null {
    return this.findings.get(id) || null;
  }

  listFindingsByScan(scanId: string): FindingRecord[] {
    return [...this.findings.values()]
      .filter((record) => record.scanId === scanId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  insertReviewEvent(event: FindingReviewEvent): void {
    this.reviewEvents.set(event.id, event);
  }

  listReviewEventsByScan(scanId: string): FindingReviewEvent[] {
    const scanFindingIds = new Set(
      this.listFindingsByScan(scanId).map((finding) => finding.id)
    );
    return [...this.reviewEvents.values()]
      .filter((event) => scanFindingIds.has(event.findingId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deleteReviewEventsByScan(scanId: string): void {
    const findingIds = new Set(
      this.listFindingsByScan(scanId).map((finding) => finding.id)
    );
    for (const [id, event] of this.reviewEvents.entries())
      if (findingIds.has(event.findingId)) this.reviewEvents.delete(id);
  }

  deleteFindingsByScan(scanId: string): void {
    for (const [id, finding] of this.findings.entries())
      if (finding.scanId === scanId) this.findings.delete(id);
  }

  deleteAnalysisRunsByScan(scanId: string): void {
    for (const [id, run] of this.analysisRuns.entries())
      if (run.scanId === scanId) this.analysisRuns.delete(id);
  }

  deleteEvidenceByScan(scanId: string): void {
    for (const [id, evidence] of this.evidence.entries())
      if (evidence.scanId === scanId) this.evidence.delete(id);
  }
}

// Constrained the same way Cloudflare's real SqlStorage.exec() is, so the
// Durable Object's `this.ctx.storage.sql` satisfies this interface directly
// without a cast, and a plain in-memory fake never needs one either.
type SqlStorageRow = Record<string, ArrayBuffer | string | number | null>;

export interface SqlExecutor {
  exec<T extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

type SqlRow = SqlStorageRow;

function mapEvidenceRow(row: SqlRow): EvidenceRecord {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    sourceType: String(row.source_type),
    sourceUrl: row.source_url ? String(row.source_url) : undefined,
    observationType: String(row.observation_type),
    observation: String(row.observation),
    capturedAt: String(row.captured_at),
    collector: String(row.collector),
    metadata: JSON.parse(String(row.metadata_json || "{}"))
  };
}

function mapAnalysisRunRow(row: SqlRow): AiAnalysisRun {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    provider: String(row.provider),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    schemaVersion: String(row.schema_version),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    evidenceIds: JSON.parse(String(row.evidence_ids_json || "[]")),
    status: String(row.status) as AiAnalysisRunStatus,
    error: row.error ? String(row.error) : null
  };
}

// SQLite can't cheaply relax an existing NOT NULL column on a table that's
// already live with data, so `severity` stays NOT NULL at the DB layer and
// "not applicable" (strength findings) is stored as this reserved sentinel
// instead of a real ALTER-TABLE migration.
const NO_SEVERITY_SENTINEL = "n/a";

function mapFindingRow(row: SqlRow): FindingRecord {
  const severity = String(row.severity);
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    analysisRunId: row.analysis_run_id ? String(row.analysis_run_id) : null,
    kind: String(row.kind || "issue") as FindingKind,
    title: String(row.title),
    category: String(row.category),
    severity: severity === NO_SEVERITY_SENTINEL ? null : (severity as Severity),
    impact: row.impact ? (String(row.impact) as FindingImpact) : undefined,
    priority: Number(row.priority),
    summary: String(row.summary),
    evidenceIds: JSON.parse(String(row.evidence_ids_json || "[]")),
    confidence: row.confidence
      ? (String(row.confidence) as EvidenceConfidence)
      : undefined,
    scoreImpact:
      row.score_impact === null || row.score_impact === undefined
        ? undefined
        : Number(row.score_impact),
    createdAt: String(row.created_at)
  };
}

function mapReviewEventRow(row: SqlRow): FindingReviewEvent {
  return {
    id: String(row.id),
    findingId: String(row.finding_id),
    action: String(row.action) as FindingReviewAction,
    previousValue: row.previous_value_json
      ? JSON.parse(String(row.previous_value_json))
      : undefined,
    newValue: row.new_value_json
      ? JSON.parse(String(row.new_value_json))
      : undefined,
    reason: row.reason ? String(row.reason) : undefined,
    reviewer: String(row.reviewer),
    createdAt: String(row.created_at)
  };
}

export class SqlAuditLedgerStore implements AuditLedgerStore {
  constructor(private readonly sql: SqlExecutor) {
    this.ensureSchema();
    // `CREATE TABLE IF NOT EXISTS` is a no-op against the table Task #3
    // already deployed to production (Client #0's first successful scan).
    // Backfill new columns the same idempotent way sales-agent.ts already
    // does for discovery_candidates.
    this.ensureColumn("audit_findings", "impact", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const exists = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((row) => row.name === column);
    if (!exists)
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_evidence (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL,
        source_type TEXT NOT NULL, source_url TEXT,
        observation_type TEXT NOT NULL, observation TEXT NOT NULL,
        captured_at TEXT NOT NULL, collector TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS audit_analysis_runs (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL,
        prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_findings (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL,
        analysis_run_id TEXT, kind TEXT NOT NULL DEFAULT 'issue',
        title TEXT NOT NULL, category TEXT NOT NULL,
        severity TEXT NOT NULL, impact TEXT, priority INTEGER NOT NULL,
        summary TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
        confidence TEXT, score_impact REAL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (analysis_run_id) REFERENCES audit_analysis_runs(id)
      );
      CREATE TABLE IF NOT EXISTS audit_review_events (
        id TEXT PRIMARY KEY, finding_id TEXT NOT NULL,
        action TEXT NOT NULL, previous_value_json TEXT, new_value_json TEXT,
        reason TEXT, reviewer TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (finding_id) REFERENCES audit_findings(id)
      );
      CREATE INDEX IF NOT EXISTS audit_evidence_scan
        ON audit_evidence(scan_id, captured_at ASC);
      CREATE INDEX IF NOT EXISTS audit_analysis_runs_scan
        ON audit_analysis_runs(scan_id, started_at ASC);
      CREATE INDEX IF NOT EXISTS audit_findings_scan
        ON audit_findings(scan_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS audit_review_events_finding
        ON audit_review_events(finding_id, created_at ASC);
    `);
  }

  insertEvidence(record: EvidenceRecord): void {
    this.sql.exec(
      `INSERT INTO audit_evidence (
        id, scan_id, source_type, source_url, observation_type, observation,
        captured_at, collector, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.scanId,
      record.sourceType,
      record.sourceUrl ?? null,
      record.observationType,
      record.observation,
      record.capturedAt,
      record.collector,
      JSON.stringify(record.metadata || {})
    );
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.sql
      .exec<SqlRow>("SELECT * FROM audit_evidence WHERE id = ?", id)
      .toArray()[0];
    return row ? mapEvidenceRow(row) : null;
  }

  listEvidenceByScan(scanId: string): EvidenceRecord[] {
    return this.sql
      .exec<SqlRow>(
        "SELECT * FROM audit_evidence WHERE scan_id = ? ORDER BY captured_at ASC",
        scanId
      )
      .toArray()
      .map(mapEvidenceRow);
  }

  insertAnalysisRun(run: AiAnalysisRun): void {
    this.sql.exec(
      `INSERT INTO audit_analysis_runs (
        id, scan_id, provider, model, prompt_version, schema_version,
        started_at, completed_at, evidence_ids_json, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.scanId,
      run.provider,
      run.model,
      run.promptVersion,
      run.schemaVersion,
      run.startedAt,
      run.completedAt,
      JSON.stringify(run.evidenceIds),
      run.status,
      run.error
    );
  }

  getAnalysisRun(id: string): AiAnalysisRun | null {
    const row = this.sql
      .exec<SqlRow>("SELECT * FROM audit_analysis_runs WHERE id = ?", id)
      .toArray()[0];
    return row ? mapAnalysisRunRow(row) : null;
  }

  updateAnalysisRun(
    id: string,
    patch: Pick<AiAnalysisRun, "status" | "completedAt" | "error">
  ): void {
    this.sql.exec(
      "UPDATE audit_analysis_runs SET status = ?, completed_at = ?, error = ? WHERE id = ?",
      patch.status,
      patch.completedAt,
      patch.error,
      id
    );
  }

  listAnalysisRunsByScan(scanId: string): AiAnalysisRun[] {
    return this.sql
      .exec<SqlRow>(
        "SELECT * FROM audit_analysis_runs WHERE scan_id = ? ORDER BY started_at ASC",
        scanId
      )
      .toArray()
      .map(mapAnalysisRunRow);
  }

  insertFinding(record: FindingRecord): void {
    this.sql.exec(
      `INSERT INTO audit_findings (
        id, scan_id, analysis_run_id, kind, title, category, severity,
        impact, priority, summary, evidence_ids_json, confidence,
        score_impact, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.scanId,
      record.analysisRunId,
      record.kind,
      record.title,
      record.category,
      record.severity ?? NO_SEVERITY_SENTINEL,
      record.impact ?? null,
      record.priority,
      record.summary,
      JSON.stringify(record.evidenceIds),
      record.confidence ?? null,
      record.scoreImpact ?? null,
      record.createdAt
    );
  }

  getFinding(id: string): FindingRecord | null {
    const row = this.sql
      .exec<SqlRow>("SELECT * FROM audit_findings WHERE id = ?", id)
      .toArray()[0];
    return row ? mapFindingRow(row) : null;
  }

  listFindingsByScan(scanId: string): FindingRecord[] {
    return this.sql
      .exec<SqlRow>(
        "SELECT * FROM audit_findings WHERE scan_id = ? ORDER BY created_at ASC",
        scanId
      )
      .toArray()
      .map(mapFindingRow);
  }

  insertReviewEvent(event: FindingReviewEvent): void {
    this.sql.exec(
      `INSERT INTO audit_review_events (
        id, finding_id, action, previous_value_json, new_value_json, reason,
        reviewer, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.findingId,
      event.action,
      event.previousValue === undefined
        ? null
        : JSON.stringify(event.previousValue),
      event.newValue === undefined ? null : JSON.stringify(event.newValue),
      event.reason ?? null,
      event.reviewer,
      event.createdAt
    );
  }

  listReviewEventsByScan(scanId: string): FindingReviewEvent[] {
    return this.sql
      .exec<SqlRow>(
        `SELECT audit_review_events.* FROM audit_review_events
         JOIN audit_findings ON audit_findings.id = audit_review_events.finding_id
         WHERE audit_findings.scan_id = ?
         ORDER BY audit_review_events.created_at ASC`,
        scanId
      )
      .toArray()
      .map(mapReviewEventRow);
  }

  deleteReviewEventsByScan(scanId: string): void {
    this.sql.exec(
      `DELETE FROM audit_review_events
       WHERE finding_id IN (SELECT id FROM audit_findings WHERE scan_id = ?)`,
      scanId
    );
  }

  deleteFindingsByScan(scanId: string): void {
    this.sql.exec("DELETE FROM audit_findings WHERE scan_id = ?", scanId);
  }

  deleteAnalysisRunsByScan(scanId: string): void {
    this.sql.exec(
      "DELETE FROM audit_analysis_runs WHERE scan_id = ?",
      scanId
    );
  }

  deleteEvidenceByScan(scanId: string): void {
    this.sql.exec("DELETE FROM audit_evidence WHERE scan_id = ?", scanId);
  }
}

export class AuditLedgerService {
  constructor(private readonly store: AuditLedgerStore) {}

  recordEvidence(
    input: Omit<EvidenceRecord, "id"> & { id?: string }
  ): EvidenceRecord {
    const record: EvidenceRecord = {
      ...input,
      id: input.id || crypto.randomUUID()
    };
    this.store.insertEvidence(record);
    return record;
  }

  startAiAnalysisRun(input: {
    scanId: string;
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: string;
    evidenceIds: string[];
  }): AiAnalysisRun {
    const evidenceIds = [...new Set(input.evidenceIds)];
    this.assertEvidenceBelongsToScan(evidenceIds, input.scanId);
    const run: AiAnalysisRun = {
      id: crypto.randomUUID(),
      scanId: input.scanId,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
      startedAt: new Date().toISOString(),
      completedAt: null,
      evidenceIds,
      status: "running",
      error: null
    };
    this.store.insertAnalysisRun(run);
    return run;
  }

  completeAiAnalysisRun(
    id: string,
    outcome: { status: "completed" | "failed"; error?: string }
  ): AiAnalysisRun {
    const run = this.store.getAnalysisRun(id);
    if (!run) throw new AuditLedgerError(`Analysis run ${id} does not exist`);
    this.store.updateAnalysisRun(id, {
      status: outcome.status,
      completedAt: new Date().toISOString(),
      error: outcome.status === "failed" ? outcome.error || "Unknown error" : null
    });
    const updated = this.store.getAnalysisRun(id);
    if (!updated)
      throw new AuditLedgerError(`Analysis run ${id} vanished after update`);
    return updated;
  }

  recordFinding(
    input: Omit<FindingRecord, "id" | "createdAt"> & { id?: string }
  ): FindingRecord {
    if (!input.evidenceIds.length)
      throw new AuditLedgerError(
        "A finding must reference at least one evidence ID"
      );
    const evidenceIds = [...new Set(input.evidenceIds)];
    this.assertEvidenceBelongsToScan(evidenceIds, input.scanId);

    if (input.analysisRunId) {
      const run = this.store.getAnalysisRun(input.analysisRunId);
      if (!run)
        throw new AuditLedgerError(
          `Analysis run ${input.analysisRunId} does not exist`
        );
      if (run.scanId !== input.scanId)
        throw new AuditLedgerError(
          `Analysis run ${input.analysisRunId} does not belong to scan ${input.scanId}`
        );
      const allowed = new Set(run.evidenceIds);
      const outOfScope = evidenceIds.filter((id) => !allowed.has(id));
      if (outOfScope.length)
        throw new AuditLedgerError(
          `AI finding references evidence outside its analysis run: ${outOfScope.join(", ")}`
        );
    }

    const record: FindingRecord = {
      ...input,
      id: input.id || crypto.randomUUID(),
      analysisRunId: input.analysisRunId ?? null,
      evidenceIds,
      createdAt: new Date().toISOString()
    };
    this.store.insertFinding(record);
    return record;
  }

  recordReviewEvent(
    input: Omit<FindingReviewEvent, "id" | "createdAt"> & { id?: string }
  ): FindingReviewEvent {
    const finding = this.store.getFinding(input.findingId);
    if (!finding)
      throw new AuditLedgerError(`Finding ${input.findingId} does not exist`);
    const event: FindingReviewEvent = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.store.insertReviewEvent(event);
    return event;
  }

  getScanAuditTrail(scanId: string): ScanAuditTrail {
    return {
      scanId,
      evidence: this.store.listEvidenceByScan(scanId),
      analysisRuns: this.store.listAnalysisRunsByScan(scanId),
      findings: this.store.listFindingsByScan(scanId),
      reviewEvents: this.store.listReviewEventsByScan(scanId)
    };
  }

  /**
   * Retention (see public-intake-retention.ts): permanently deletes a
   * scan's full audit trail, in the dependency order the underlying
   * FOREIGN KEY relationships require — review events (reference
   * findings) before findings (reference analysis runs) before analysis
   * runs, with evidence last (nothing references it by FK; findings/
   * analysis runs only cite it by ID inside their own JSON arrays, which
   * disappear along with the row that holds them).
   */
  deleteScanAuditTrail(scanId: string): void {
    this.store.deleteReviewEventsByScan(scanId);
    this.store.deleteFindingsByScan(scanId);
    this.store.deleteAnalysisRunsByScan(scanId);
    this.store.deleteEvidenceByScan(scanId);
  }

  private assertEvidenceBelongsToScan(
    evidenceIds: string[],
    scanId: string
  ): void {
    for (const evidenceId of evidenceIds) {
      const evidence = this.store.getEvidence(evidenceId);
      if (!evidence)
        throw new AuditLedgerError(`Evidence ${evidenceId} does not exist`);
      if (evidence.scanId !== scanId)
        throw new AuditLedgerError(
          `Evidence ${evidenceId} does not belong to scan ${scanId}`
        );
    }
  }
}
