// Phase 2.10 — ReelHaus commercial calibration layer.
//
// A pure, standalone interpretation layer on TOP of an already-completed
// ReelScan result — it never touches evidence collection, the AI pipeline,
// or scoring (all unchanged, all still live in reelscan.ts). This module
// answers a different question than reelscan.ts does: reelscan.ts asks
// "how healthy is this website, technically?" — this module asks "is this
// a realistic ReelHaus customer, and if so, what should we do about it?"
//
// Deliberately NOT inside reelscan.ts (see Task #2.10) and deliberately
// has zero imports from anything with I/O: no database, no API, no AI, no
// network, no Durable Object. Only type-only imports from reelscan.ts/
// audit-ledger.ts (erased at compile time). Business context (category/
// location) is supplied by the caller — a human reviewer, or a dataset
// like the validation runner's — never invented or derived here, and
// never requires a new database field: nothing here is persisted by this
// module at all.
import type { EvidenceRecord, FindingRecord } from "./audit-ledger";
import type { ReelScanRecommendation, ReelScanScore } from "./reelscan";

export type ReelHausOpportunityLevel = "high" | "medium" | "low";
export type CommercialRecommendedService =
  | "ReelFix"
  | "ReelBuild"
  | "ReelCare"
  | "No action";
export type CommercialConfidence = "high" | "medium" | "low";

export interface CommercialAnalysisInput {
  businessName: string;
  /**
   * Free-text business type/context, e.g. "independent restaurant",
   * "boutique riad", "luxury international hotel", "hotel chain".
   * Optional — caller-supplied, never derived from the scan itself.
   */
  category?: string;
  location?: string;
  score: ReelScanScore | null;
  recommendation: ReelScanRecommendation | null;
  findings: FindingRecord[];
  /**
   * Task #2.18 — now used to gate the ReelBuild boundary (see
   * hasCriticalFoundationalIssue below): a critical positioning/
   * service_clarity finding only counts toward ReelBuild if it cites
   * verified, deterministic evidence found here. Optional and never
   * mutated; when omitted, no finding can satisfy that gate, which is the
   * conservative, never-falsely-ReelBuild default.
   */
  websiteEvidence?: EvidenceRecord[];
}

export interface TechnicalScoreExplanation {
  /** Passed through from ReelScan's own score, verbatim — never recomputed or adjusted here. */
  technicalHealthScore: number | null;
  /** Deliberately not "business quality" or "overall score" — this is a technical-health reading only. */
  label: "Technical Website Health";
}

export type ImprovementNeedLevel = "high" | "medium" | "low";
export type SalesRecommendation = "Contact" | "Research more" | "No action";

/**
 * Task #2.13 — the "second layer": a higher-level sales read on top of the
 * same opportunity/recommendedService fields above, not a re-derivation
 * from scratch. `businessFit` is literally `opportunityLevel` under the
 * vocabulary a reviewer thinks in ("is this a realistic prospect"), not a
 * second classification — see analyzeCommercialContext() below.
 */
export interface SalesDecisionLayer {
  businessFit: ReelHausOpportunityLevel;
  improvementNeed: ImprovementNeedLevel;
  salesRecommendation: SalesRecommendation;
}

/**
 * Task #2.16 — a separate, additional signal from businessFit: WHAT KIND
 * of realistic prospect this is, not simply whether to approach them.
 * Deliberately independent of improvementNeed and the technical score —
 * computed from `category` alone, nothing else, and never fed back into
 * either of those.
 */
export type BusinessSegment =
  | "small_independent"
  | "premium_independent"
  | "large_or_chain"
  | "unknown";

export interface CommercialAnalysisResult {
  technical: TechnicalScoreExplanation;
  opportunityLevel: ReelHausOpportunityLevel;
  /** Task #2.16 — additional context alongside opportunityLevel; see BusinessSegment. */
  businessSegment: BusinessSegment;
  recommendedService: CommercialRecommendedService;
  /** Plain business language — no developer/HTML/accessibility terms. */
  explanation: string;
  confidence: CommercialConfidence;
  /** Why this confidence level, in plain language — always present, never a mystery rating. */
  confidenceReason: string;
  salesDecision: SalesDecisionLayer;
}

// -- ReelHaus opportunity level + business segment (Task #2.16) ----------

// Deliberately simple keyword matching, not a hidden brand list (no
// "Four Seasons"/"Royal Mansour" name lookup): any caller supplying
// `category` can see exactly why a business landed where it did by
// reading these patterns — transparency was an explicit requirement, in
// #2.10 and reaffirmed in #2.16.
//
// Realistic ReelHaus target types — independent hospitality venues.
// Compound/generic terms ("food experience", "culinary tour") are
// deliberately matched as whole phrases, not the bare broad word alone
// ("experience", "tour"), so an unrelated generic business whose category
// merely contains "experience" is never swept in by accident.
const INDEPENDENT_CATEGORY_PATTERN =
  /independent|restaurant|caf[eé]|coffee\s?shop|riad|bistro|snack|guest\s?house|boutique|small hotel|family[- ]owned|family hotel|(eco[- ]?)?lodge|hammam|\bspa\b|wellness|cooking school|culinary school|(food|culinary|hospitality) experience/i;

// "tour"/"excursion" alone are too generic (could be any tour operator,
// not hospitality) — only counted when paired with a hospitality/tourism
// qualifier in the same category string. Kept separate from the pattern
// above so this narrower rule is easy to spot and audit on its own.
const TOUR_HOSPITALITY_QUALIFIER_PATTERN =
  /food|culinary|gastronomic|cultural|heritage|hospitality|riad|guest\s?house/i;
function isHospitalityTourCategory(category: string): boolean {
  return (
    /\btour(s|ing)?\b|\bexcursion\b/i.test(category) &&
    TOUR_HOSPITALITY_QUALIFIER_PATTERN.test(category)
  );
}

// Genuinely large/chain-scale language — this, not premium styling on
// its own, is what makes a business unrealistic for ReelHaus. An
// independent property can legitimately be described as "luxury" or
// "premium" without being a global brand — see PREMIUM_STYLING_PATTERN
// below, which captures that as a *segment* instead of forcing Low fit.
const LARGE_OR_CHAIN_PATTERN =
  /\bchain\b|hotel\s+group|resort\s+group|hospitality\s+group|large\s+group|enterprise\s+hospitality|palace[- ]scale|(international|global|multinational)\s+(hotel|resort|brand|chain|group)|(hotel|resort|brand)\s+(chain|group)/i;

// Premium/luxury STYLING language only — never on its own a reason to
// drop opportunity to Low (that's LARGE_OR_CHAIN_PATTERN's job). Only
// used to mark the segment as premium when the category is ALSO
// independent-type (see classifyBusinessSegment).
const PREMIUM_STYLING_PATTERN =
  /luxury|premium|palace|five[- ]star|5[- ]star|ultra[- ]luxury|high[- ]end|upscale/i;

// category is expected to describe business TYPE/scale ("luxury
// international hotel chain"), not just a bare brand name — a literal
// "Four Seasons" with no other words falls to "unknown", same as any
// other unrecognized category (see classifyConfidence below, which is
// honest about that rather than pretending certainty).
function classifyBusinessSegment(category?: string): BusinessSegment {
  if (!category) return "unknown";
  if (LARGE_OR_CHAIN_PATTERN.test(category)) return "large_or_chain";
  const isIndependentType =
    INDEPENDENT_CATEGORY_PATTERN.test(category) ||
    isHospitalityTourCategory(category);
  if (!isIndependentType) return "unknown";
  return PREMIUM_STYLING_PATTERN.test(category)
    ? "premium_independent"
    : "small_independent";
}

function classifyOpportunityLevel(
  segment: BusinessSegment
): ReelHausOpportunityLevel {
  if (segment === "large_or_chain") return "low";
  if (segment === "small_independent" || segment === "premium_independent")
    return "high";
  return "medium";
}

// -- Recommended service (business interpretation, not reelscan.ts's own
//    action verbatim — see below) ----------------------------------------

// This module's own notion of "the site doesn't establish who the
// business is or what it offers" — defined independently of reelscan.ts's
// internal FOUNDATIONAL_CATEGORIES (not exported, and intentionally not
// imported: this is a separate business interpretation, allowed to draw
// its own line, even though it happens to use the same category values a
// FindingRecord already carries).
const FOUNDATIONAL_ISSUE_CATEGORIES: ReadonlySet<string> = new Set([
  "positioning",
  "service_clarity"
]);

// Task #2.18 — P0 reliability fix (Riad Kniza instability: the SAME
// unmodified site swung between ReelFix and ReelBuild across separate
// pilot runs — Tasks #2.9/#2.12/#2.15 — purely from the AI's own
// subjective severity call on a positioning/service_clarity finding). A
// critical foundational finding is only eligible to trigger ReelBuild if
// it cites at least one VERIFIED, deterministic piece of evidence, not
// merely the AI's own severity judgment — mirroring the exact standard
// reelscan.ts's applySeverityFloor() already holds AI-reported severity
// to. Kept as a literal, independent copy (not a value import) for the
// same reason FOUNDATIONAL_ISSUE_CATEGORIES above is: this module
// intentionally takes zero I/O and zero value imports from reelscan.ts
// (see this file's header comment). If reelscan.ts ever adds a new
// deterministic evidence collector, add its exact string here too.
const DETERMINISTIC_EVIDENCE_COLLECTORS: ReadonlySet<string> = new Set([
  "website-analysis@analyzeReelHaus",
  "reelscan-v1@generic-website-checks"
]);

function isEvidenceVerified(evidence: EvidenceRecord): boolean {
  return evidence.metadata?.verification !== "inference";
}

function isFoundationallyEvidenceBacked(
  finding: FindingRecord,
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): boolean {
  return finding.evidenceIds.some((id) => {
    const item = evidenceById.get(id);
    return (
      item !== undefined &&
      DETERMINISTIC_EVIDENCE_COLLECTORS.has(item.collector) &&
      isEvidenceVerified(item)
    );
  });
}

function hasCriticalFoundationalIssue(
  findings: FindingRecord[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): boolean {
  return findings.some(
    (finding) =>
      finding.kind === "issue" &&
      finding.severity === "critical" &&
      FOUNDATIONAL_ISSUE_CATEGORIES.has(finding.category) &&
      isFoundationallyEvidenceBacked(finding, evidenceById)
  );
}

// Task #2.13 calibration fix: "any single important issue = ReelFix" was
// too blunt — the Moroccan hospitality pilot (Task #2.12) surfaced real
// cases (e.g. a site with exactly one minor link-labeling issue) getting
// the same ReelFix pitch as a site with seven real defects. Issue COUNT
// and severity now both matter, via a simple, transparent weighted sum —
// not a second, hidden judgment call. Critical outweighs important
// outweighs optional by design; the exact numbers are named constants
// below so the reasoning is inspectable, not a black box.
const IMPROVEMENT_NEED_WEIGHT: Record<string, number> = {
  critical: 5,
  important: 2,
  optional: 1
};
// >= HIGH: "many meaningful issues" -> ReelFix.
// >= MEDIUM (but below HIGH): "only small issues" -> ReelCare.
// 0: "no meaningful issues" -> No action (see classifyRecommendedService).
const IMPROVEMENT_NEED_HIGH_THRESHOLD = 4;
const IMPROVEMENT_NEED_MEDIUM_THRESHOLD = 1;

function improvementNeedWeight(findings: FindingRecord[]): number {
  return findings.reduce(
    (sum, finding) =>
      finding.kind === "issue"
        ? sum + (IMPROVEMENT_NEED_WEIGHT[finding.severity || ""] || 0)
        : sum,
    0
  );
}

function classifyImprovementNeed(findings: FindingRecord[]): ImprovementNeedLevel {
  const weight = improvementNeedWeight(findings);
  if (weight >= IMPROVEMENT_NEED_HIGH_THRESHOLD) return "high";
  if (weight >= IMPROVEMENT_NEED_MEDIUM_THRESHOLD) return "medium";
  return "low";
}

// Explicitly NOT `input.recommendation.action` — this is a new,
// independent business classification computed from the same findings,
// not a copy of ReelScan's technical Fix/Build/Care call. A `low`
// opportunity business gets "No action" regardless of technical
// condition: pursuing a business outside ReelHaus's realistic market
// isn't a decision that should hinge on whether their alt text is
// missing. This is exactly what the validation pilot flagged as missing
// (luxury brands and small restaurants getting the same recommendation).
//
// Below `low` opportunity: many meaningful issues -> ReelFix; only small
// issues -> ReelCare; no meaningful issues -> No action (nothing to
// pitch, technically) — a foundational critical issue still overrides
// straight to ReelBuild regardless of the weighted count, since a
// missing identity/positioning is categorically worse than "many small
// issues," not just a bigger pile of them.
function classifyRecommendedService(
  opportunityLevel: ReelHausOpportunityLevel,
  improvementNeed: ImprovementNeedLevel,
  findings: FindingRecord[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): CommercialRecommendedService {
  if (opportunityLevel === "low") return "No action";
  if (hasCriticalFoundationalIssue(findings, evidenceById)) return "ReelBuild";
  if (improvementNeed === "high") return "ReelFix";
  if (improvementNeed === "medium") return "ReelCare";
  return "No action";
}

// Task #2.13 — the higher-level sales call: given a realistic-fit
// business, is there enough here to actually reach out about right now,
// or is it worth keeping an eye on without pushing? `low` fit always
// wins regardless of the site's condition (same reasoning as
// classifyRecommendedService above). Transparent decision table, not a
// score: every combination is an explicit, readable branch.
function classifySalesRecommendation(
  opportunityLevel: ReelHausOpportunityLevel,
  improvementNeed: ImprovementNeedLevel
): SalesRecommendation {
  if (opportunityLevel === "low") return "No action";
  // Both `high` and `medium` fit only reach an outright "Contact" when
  // there's a genuinely strong pile of issues to pitch (`high` need).
  // A `medium`-need site — "excellent, just a couple of small things" —
  // is still worth keeping on the radar, not an immediate pitch: Task
  // #2.13 example 2 (independent boutique hotel, excellent website) maps
  // to "Research more", not "Contact".
  return improvementNeed === "high" ? "Contact" : "Research more";
}

// -- Confidence -----------------------------------------------------------

// Task #2.16: reasons now name the actual segment that was detected
// ("Independent restaurant category detected") instead of a generic
// "a clear category is available" — and are honest when the supplied
// category doesn't contain enough information, rather than claiming
// high confidence it doesn't have.
function classifyConfidence(
  input: CommercialAnalysisInput,
  segment: BusinessSegment
): { confidence: CommercialConfidence; reason: string } {
  if (input.score === null)
    return {
      confidence: "low",
      reason:
        "The scan did not produce a usable technical score, which limits how confidently this assessment can be made."
    };
  if (!input.category)
    return {
      confidence: "low",
      reason:
        "Business category is missing, so ReelHaus market fit is inferred generically rather than confirmed."
    };
  switch (segment) {
    case "small_independent":
      return {
        confidence: "high",
        reason: `Independent hospitality category detected ("${input.category}").`
      };
    case "premium_independent":
      return {
        confidence: "high",
        reason: `Independent premium/boutique hospitality category detected ("${input.category}").`
      };
    case "large_or_chain":
      return {
        confidence: "high",
        reason: `Large or chain-scale hospitality category detected ("${input.category}").`
      };
    default:
      return {
        confidence: "medium",
        reason:
          "Business category is present but ambiguous — it does not clearly indicate an independent business, a premium independent property, or a large/chain operator."
      };
  }
}

// -- Human-readable explanation (plain business language only) -----------

function buildExplanation(
  businessName: string,
  opportunityLevel: ReelHausOpportunityLevel,
  recommendedService: CommercialRecommendedService
): string {
  // "No action" now has two distinct, non-interchangeable causes — say
  // the right one, never the wrong one (Task #2.13: this used to always
  // claim "luxury brand," which became false once a good-fit business
  // with zero meaningful issues could also reach "No action").
  if (recommendedService === "No action" && opportunityLevel === "low")
    return `${businessName} is a large or luxury hospitality brand, outside ReelHaus's realistic target market — no action is recommended regardless of website condition.`;
  switch (recommendedService) {
    case "No action":
      return `${businessName} already has an excellent, well-functioning website with no meaningful issues found — no action is needed at this time.`;
    case "ReelBuild":
      return `${businessName} does not have a clear, working website foundation — visitors may struggle to understand what is offered or how to take the next step.`;
    case "ReelCare":
      return `${businessName} has a strong, well-functioning website — ongoing light maintenance would help keep it that way.`;
    case "ReelFix":
    default: {
      const fit =
        opportunityLevel === "high"
          ? "an independent hospitality business"
          : "an established hospitality business";
      return `${businessName} is ${fit} with a clear identity but technical website issues that may reduce visibility and conversion.`;
    }
  }
}

/**
 * Turns an already-completed ReelScan result into a ReelHaus business
 * decision: is this a realistic customer, and if so what should ReelHaus
 * actually do? Pure function — no I/O, nothing mutated, technical score
 * always passed through unchanged.
 */
export function analyzeCommercialContext(
  input: CommercialAnalysisInput
): CommercialAnalysisResult {
  const businessSegment = classifyBusinessSegment(input.category);
  const opportunityLevel = classifyOpportunityLevel(businessSegment);
  const improvementNeed = classifyImprovementNeed(input.findings);
  const evidenceById = new Map(
    (input.websiteEvidence ?? []).map((item) => [item.id, item])
  );
  const recommendedService = classifyRecommendedService(
    opportunityLevel,
    improvementNeed,
    input.findings,
    evidenceById
  );
  const { confidence, reason } = classifyConfidence(input, businessSegment);
  return {
    technical: {
      technicalHealthScore: input.score?.score ?? null,
      label: "Technical Website Health"
    },
    opportunityLevel,
    businessSegment,
    recommendedService,
    explanation: buildExplanation(
      input.businessName,
      opportunityLevel,
      recommendedService
    ),
    confidence,
    confidenceReason: reason,
    salesDecision: {
      businessFit: opportunityLevel,
      improvementNeed,
      salesRecommendation: classifySalesRecommendation(
        opportunityLevel,
        improvementNeed
      )
    }
  };
}
