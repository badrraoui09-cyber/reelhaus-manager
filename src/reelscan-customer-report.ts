// Phase 2.6 — ReelScan customer report formatter (v1).
//
// A pure presentation layer: takes an already-computed ReelScan result
// (score, recommendation, findings) and reshapes it into a customer-
// readable report. It does not compute anything — no scoring, no AI
// reasoning, no evidence collection. Those all stay exactly where they
// are, in reelscan.ts, unchanged.
//
// Deliberately has zero imports from anything with I/O: no database, no
// network, no AI binding, no Durable Object. Only type-only imports from
// reelscan.ts/audit-ledger.ts (erased at compile time, no runtime
// coupling) so this module can be unit-tested with plain objects and
// nothing else — the same shape as business-workspace.ts's existing
// "pure formatter, DO composes it" pattern in this codebase.
//
// Not wired into any route, the Manager UI, PDF/email export, or the
// public API in this task — see docs/reelscan-public-intake-security.md
// §11: the public intake response is deliberately tested to reveal
// nothing beyond {ok, status}, and changing that is its own, separate,
// security-reviewed task, not this one.
import type { FindingRecord } from "./audit-ledger";
import type {
  ReelScanCategory,
  ReelScanRecommendation,
  ReelScanRecommendedAction,
  ReelScanScore
} from "./reelscan";

export interface ReelScanCustomerReportInput {
  businessName: string;
  targetUrl: string;
  score: ReelScanScore | null;
  recommendation: ReelScanRecommendation | null;
  findings: FindingRecord[];
}

export interface ReelScanCustomerReportOpportunity {
  /** Friendly section label, e.g. "Mobile experience" — never the raw category enum value. */
  area: string;
  /** Plain-language business-impact explanation — never the raw technical title/summary/evidence. */
  whatWeFound: string;
}

export interface ReelScanCustomerReportRecommendation {
  action: ReelScanRecommendedAction;
  explanation: string;
}

export interface ReelScanCustomerReport {
  businessName: string;
  websiteUrl: string;
  scoreOutOf100: number | null;
  recommendation: ReelScanCustomerReportRecommendation | null;
  highlights: string[];
  opportunities: ReelScanCustomerReportOpportunity[];
}

// Matched by keyword/pattern against title+summary rather than exact title
// text, because the AI's exact finding titles vary run to run for the same
// underlying defect (e.g. "Images without alt attributes" vs. "Missing Alt
// Attributes on Images"). Unmatched issues fall back to their existing
// technical summary — never blank, never invented. Moved here unchanged
// from reelscan.ts (Phase 2.5) as part of Phase 2.6.
const CUSTOMER_FRIENDLY_ISSUE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  explain: string;
}> = [
  {
    pattern: /alt attribute|alt text/i,
    explain:
      "Some images have no description text, so visitors using screen readers and Google Image Search may not understand what they show."
  },
  {
    pattern: /accessible name/i,
    explain:
      "Some buttons and links may be harder for visitors and search engines to understand."
  },
  {
    pattern: /\bh1\b|main heading|heading structure/i,
    explain:
      "The page doesn't clearly signal a single main topic to visitors and search engines."
  },
  {
    pattern: /canonical/i,
    explain:
      "Search engines may have trouble telling which page address is the definitive one, which can hurt search ranking."
  },
  {
    pattern: /unlabeled|without a name|form.*label|label.*form/i,
    explain:
      "A contact or reservation form may be confusing for visitors to fill out correctly."
  },
  {
    pattern: /meta description/i,
    explain:
      "The short preview text shown in Google search results isn't ideally sized, which can affect how the listing looks."
  },
  {
    pattern: /viewport|responsive|mobile/i,
    explain:
      "The page may not display well on mobile phones, where most visitors are likely browsing from."
  }
];

/**
 * Plain-language business-impact explanation for a single finding.
 * Strengths and uncertain notes pass through their existing summary
 * unchanged (already written in fairly plain language — the jargon
 * problem is specific to technical issue titles). Never leaks
 * evidenceIds, confidence, severity, or collector — it only ever reads
 * kind/title/summary and returns a new string.
 */
export function customerFacingSummary(
  finding: Pick<FindingRecord, "kind" | "title" | "summary">
): string {
  if (finding.kind !== "issue") return finding.summary;
  const haystack = `${finding.title} ${finding.summary}`;
  return (
    CUSTOMER_FRIENDLY_ISSUE_PATTERNS.find((entry) =>
      entry.pattern.test(haystack)
    )?.explain || finding.summary
  );
}

const FRIENDLY_CATEGORY_LABELS: Partial<Record<ReelScanCategory, string>> = {
  positioning: "First impression",
  trust: "Building trust",
  action_path: "Getting visitors to take action",
  service_clarity: "Explaining what you offer",
  technical: "Technical health",
  mobile: "Mobile experience",
  consistency: "Consistency & accessibility"
};

// category on FindingRecord is `string`, not the narrower ReelScanCategory
// union (findings can in principle carry any category string) — an
// unrecognized value still gets a readable label, never a blank one and
// never the raw snake_case enum value. Exported (Task #2.8) so the
// validation dataset runner can group raw findings by the same friendly
// label buildReelScanCustomerReport() uses for `opportunities[].area`,
// instead of re-declaring this table a second time.
export function friendlyCategoryLabel(category: string): string {
  return (
    FRIENDLY_CATEGORY_LABELS[category as ReelScanCategory] ||
    category
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

const RECOMMENDATION_EXPLANATIONS: Record<ReelScanRecommendedAction, string> = {
  ReelFix:
    "Your website works well overall — a few specific, quick fixes would remove friction for visitors.",
  ReelBuild:
    "Your website has a fundamental gap in how it presents your business — it likely needs to be rebuilt rather than patched.",
  ReelCare:
    "Your website is in strong shape — ongoing light maintenance will help it stay that way.",
  no_immediate_change:
    "No significant issues were found — no action is needed right now."
};

/**
 * Transforms an internal ReelScan result into a customer-facing report.
 * Pure function: no I/O, no persistence, nothing here mutates its input.
 * Only ever reads kind/title/summary/category off a finding — never
 * evidenceIds, confidence, severity, or scoreImpact — so raw evidence and
 * internal metadata cannot leak into the output by construction.
 */
export function buildReelScanCustomerReport(
  input: ReelScanCustomerReportInput
): ReelScanCustomerReport {
  const strengths = input.findings.filter((finding) => finding.kind === "strength");
  const issues = input.findings.filter((finding) => finding.kind === "issue");

  return {
    businessName: input.businessName,
    websiteUrl: input.targetUrl,
    scoreOutOf100: input.score?.score ?? null,
    recommendation: input.recommendation
      ? {
          action: input.recommendation.action,
          explanation: RECOMMENDATION_EXPLANATIONS[input.recommendation.action]
        }
      : null,
    highlights: strengths.map((finding) => customerFacingSummary(finding)),
    opportunities: issues.map((finding) => ({
      area: friendlyCategoryLabel(finding.category),
      whatWeFound: customerFacingSummary(finding)
    }))
  };
}
