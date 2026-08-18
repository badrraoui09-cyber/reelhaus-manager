// Task #2.19 — ReelFix proof loop, Part B: a pure before/after comparison
// between a completed baseline scan and a completed verification scan.
//
// Zero I/O — the same "pure formatter, DO composes it" shape reelscan-
// customer-report.ts already uses, which this module reuses
// (customerFacingSummary/friendlyCategoryLabel) rather than re-
// implementing customer-safe wording a second time.
//
// The Riad Kniza instability (Task #2.18) showed that the AI's own
// wording/severity/category choice for the SAME underlying evidence can
// vary between runs. Matching findings by raw AI title/summary text
// would therefore be unsafe here in a new way: it could either miss a
// genuinely resolved issue (different wording -> looks unrelated/new), or
// — worse — silently claim an issue was "resolved" just because the AI
// happened to word it differently on re-scan. This module never compares
// AI wording directly. It matches "issue" findings by a STABLE, evidence-
// derived identity — the exact same deterministic-collector / verified-
// evidence standard Task #2.18's ReelBuild gate and reelscan.ts's own
// applySeverityFloor()/consolidateFindings() already hold AI output to.
// A finding with no such identity (a purely AI-interpreted judgment,
// backed only by unverified/content evidence) is never matched across
// scans in either direction: it is reported as "needs review", never as
// confidently resolved and never as confidently new. See
// stableIssueKey() below.
import type { EvidenceRecord, FindingRecord } from "./audit-ledger";
import type { ReelScanScore } from "./reelscan";
import { customerFacingSummary, friendlyCategoryLabel } from "./reelscan-customer-report";

export interface ReelFixComparisonScanInput {
  scanId: string;
  score: ReelScanScore | null;
  findings: FindingRecord[];
  evidence: EvidenceRecord[];
}

export interface ReelFixComparisonInput {
  baseline: ReelFixComparisonScanInput;
  verification: ReelFixComparisonScanInput;
}

// Deliberately just area + plain-language text — the same customer-safe
// shape reelscan-customer-report.ts's own opportunities/highlights use.
// Never carries evidenceIds, severity, confidence, or a collector name.
export interface ReelFixComparisonItem {
  area: string;
  whatWeFound: string;
}

export interface ReelFixComparisonResult {
  resolved: ReelFixComparisonItem[];
  remaining: ReelFixComparisonItem[];
  newIssues: ReelFixComparisonItem[];
  /**
   * AI-only findings (no stable evidence identity) from either scan that
   * could not be reliably matched — never promoted to resolved/remaining/
   * newIssues. This is the conservative fallback Task #2.19 explicitly
   * requires: "if an AI-only subjective finding cannot be reliably
   * matched across scans, do not falsely claim that it was resolved."
   */
  needsReview: ReelFixComparisonItem[];
  strengths: string[];
  technicalHealthScore: { before: number | null; after: number | null };
}

// -- Stable, evidence-derived issue identity ---------------------------------
//
// Deliberately independent of (never imported from) reelscan.ts's and
// reelscan-commercial-analysis.ts's own copies of this exact rule (Task
// #2.18) — see those files' header comments for why this codebase
// intentionally duplicates small, transparent, auditable rules like this
// one instead of coupling otherwise-independent pure modules together.
const DETERMINISTIC_EVIDENCE_COLLECTORS: ReadonlySet<string> = new Set([
  "website-analysis@analyzeReelHaus",
  "reelscan-v1@generic-website-checks"
]);

function isEvidenceVerified(evidence: EvidenceRecord): boolean {
  return evidence.metadata?.verification !== "inference";
}

/**
 * The stable identity of an "issue" finding, or null if it has none.
 * Only evidence from a deterministic collector, actually verified (not
 * inference), counts — the same standard reelscan.ts's severity floor and
 * Task #2.18's ReelBuild gate hold AI-reported severity to. A finding
 * citing several such evidence items (e.g. consolidated across locales)
 * gets the sorted, joined set of their root keys — mirroring
 * consolidateFindings()'s own evidenceRootKeySetKey() in reelscan.ts.
 * Category is deliberately NOT part of the key: the AI can (and does)
 * sometimes categorize the exact same underlying evidence differently
 * between scans depending on whether it chose to mention it itself or
 * left it to deterministic injection (see reelscan.ts's
 * mapGuardianCategory()) — keying on category too would produce spurious
 * "resolved" + "new" pairs for what is really one unchanged defect.
 */
function stableIssueKey(
  finding: FindingRecord,
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): string | null {
  if (finding.kind !== "issue") return null;
  const keys = new Set<string>();
  for (const id of finding.evidenceIds) {
    const item = evidenceById.get(id);
    if (!item) continue;
    if (!DETERMINISTIC_EVIDENCE_COLLECTORS.has(item.collector)) continue;
    if (!isEvidenceVerified(item)) continue;
    const rootKey = item.metadata?.rootFindingKey;
    keys.add(typeof rootKey === "string" && rootKey ? rootKey : item.observationType);
  }
  return keys.size ? [...keys].sort().join("+") : null;
}

interface PartitionedIssues {
  byKey: Map<string, FindingRecord>;
  unmatched: FindingRecord[];
}

function partitionIssues(
  findings: FindingRecord[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): PartitionedIssues {
  const byKey = new Map<string, FindingRecord>();
  const unmatched: FindingRecord[] = [];
  for (const finding of findings) {
    if (finding.kind !== "issue") continue;
    const key = stableIssueKey(finding, evidenceById);
    if (key) byKey.set(key, finding);
    else unmatched.push(finding);
  }
  return { byKey, unmatched };
}

function toItem(finding: FindingRecord): ReelFixComparisonItem {
  return {
    area: friendlyCategoryLabel(finding.category),
    whatWeFound: customerFacingSummary(finding)
  };
}

/**
 * Pure. Never mutates its input, never calls AI, never touches the audit
 * ledger — the caller (public-intake-service.ts) is responsible for
 * loading both scans' findings/evidence/score first.
 */
export function compareReelFixOutcome(
  input: ReelFixComparisonInput
): ReelFixComparisonResult {
  const baselineEvidenceById = new Map(
    input.baseline.evidence.map((item) => [item.id, item])
  );
  const verificationEvidenceById = new Map(
    input.verification.evidence.map((item) => [item.id, item])
  );
  const baselineIssues = partitionIssues(input.baseline.findings, baselineEvidenceById);
  const verificationIssues = partitionIssues(
    input.verification.findings,
    verificationEvidenceById
  );

  const resolved: ReelFixComparisonItem[] = [];
  const remaining: ReelFixComparisonItem[] = [];
  for (const [key, baselineFinding] of baselineIssues.byKey) {
    const stillPresent = verificationIssues.byKey.get(key);
    if (stillPresent) remaining.push(toItem(stillPresent));
    else resolved.push(toItem(baselineFinding));
  }

  const newIssues: ReelFixComparisonItem[] = [];
  for (const [key, verificationFinding] of verificationIssues.byKey)
    if (!baselineIssues.byKey.has(key)) newIssues.push(toItem(verificationFinding));

  const needsReview = [
    ...baselineIssues.unmatched,
    ...verificationIssues.unmatched
  ].map(toItem);

  const strengths = input.verification.findings
    .filter((finding) => finding.kind === "strength")
    .map((finding) => customerFacingSummary(finding));

  return {
    resolved,
    remaining,
    newIssues,
    needsReview,
    strengths,
    technicalHealthScore: {
      before: input.baseline.score?.score ?? null,
      after: input.verification.score?.score ?? null
    }
  };
}
