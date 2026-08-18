// Task #2.19 — ReelFix proof loop, Part C: the customer-facing ReelFix
// before/after proof report.
//
// Two pure steps, deliberately kept separate (the same "data layer, then
// presentation layer" split reelscan-customer-report.ts already
// establishes for the plain ReelScan report):
//   1. buildReelFixProofReport() — assembles a customer-SAFE structured
//      object from two already-computed ReelScanCustomerReports and a
//      ReelFixComparisonResult. Zero I/O, no AI call: every sentence here
//      is composed deterministically from data that already exists.
//   2. renderReelFixProofReportHtml() — turns that object into a single,
//      print-friendly HTML string. No external resources, no client-side
//      script: an Access-authenticated ReelHaus operator opens it in a
//      browser and uses the browser's own "Print -> Save as PDF," which
//      is all Task #2.19 asks a P0 proof loop to support. No PDF-
//      generation dependency, no email, no auto-delivery.
//
// This module never re-derives commercial/sales data (Business Fit,
// Business Segment, improvementNeed, salesRecommendation, reviewDecision)
// and never reads raw evidenceIds/collector/analysisRunId/scoreImpact/
// confidence off a finding — it only ever consumes the already-customer-
// safe ReelScanCustomerReport and ReelFixComparisonResult shapes, so
// nothing internal can leak here by construction. See
// reelfix-proof-report.test.ts for the explicit leak-safety assertions.
import type { ReelScanCustomerReport } from "./reelscan-customer-report";
import type { ReelFixComparisonResult } from "./reelfix-comparison";

export interface ReelFixProofReportInput {
  businessName: string;
  websiteUrl: string;
  /** ISO timestamp — when the verification link was created, not "now". */
  verificationDate: string;
  baselineReport: ReelScanCustomerReport;
  verificationReport: ReelScanCustomerReport;
  comparison: ReelFixComparisonResult;
}

export interface ReelFixProofReportImprovement {
  area: string;
  whatWasWrong: string;
  nowImproved: string;
}

export interface ReelFixProofReportIssue {
  area: string;
  whatWeFound: string;
}

export interface ReelFixProofReportRecommendation {
  headline: string;
  explanation: string;
}

export interface ReelFixProofReport {
  businessName: string;
  websiteUrl: string;
  verificationDate: string;
  /** The headline of the report — never the raw score movement. */
  whatChanged: string;
  improvementsCompleted: ReelFixProofReportImprovement[];
  /** Confirmed-still-open issues AND unconfirmed (needs-review) items — see the module comment on why these are never split into a separate, more assertive bucket. */
  stillToReview: ReelFixProofReportIssue[];
  newIssues: ReelFixProofReportIssue[];
  whatIsWorking: string[];
  technicalHealth: { before: number | null; after: number | null };
  nextRecommendation: ReelFixProofReportRecommendation;
}

const MAX_WHAT_CHANGED_AREAS = 3;
const MAX_STRENGTHS_SHOWN = 5;

// Deterministic, template-composed — no AI call in this layer. Always
// leads with "verified improvements" language (Task #2.19 Part E's
// explicit guidance), never "all issues fixed": this module has no scope-
// tracking concept of what was "promised," only what the evidence
// actually shows changed between the two scans.
function composeWhatChanged(comparison: ReelFixComparisonResult): string {
  const areas = [...new Set(comparison.resolved.map((item) => item.area))];
  if (!areas.length) {
    return comparison.remaining.length || comparison.needsReview.length
      ? "The agreed improvements are still being verified — nothing was confirmed fixed between these two scans yet."
      : "No changes were detected between these two scans.";
  }
  const shown = areas.slice(0, MAX_WHAT_CHANGED_AREAS);
  const list =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  const remainder =
    areas.length > shown.length ? ", among other areas," : "";
  return `Verified improvements were made to: ${list}${remainder}.`;
}

// Reuses the verification scan's OWN already-customer-safe recommendation
// (buildReelScanCustomerReport()'s RECOMMENDATION_EXPLANATIONS) rather
// than inventing new commercial language here — this is exactly the rule
// Task #2.19 requires ("Only customer-facing service language... NEVER
// expose Contact / Research more / internal Business Fit / Business
// Segment / internal sales decision"), satisfied by construction because
// that internal vocabulary was never in scope for
// buildReelScanCustomerReport() to begin with.
function composeNextRecommendation(
  verificationReport: ReelScanCustomerReport
): ReelFixProofReportRecommendation {
  // Task #2.20 P0 wording fix: this report only knows that a verification
  // scan ran and what it found — it has no record of a human declaring
  // the AGREED commercial scope complete (no scope/approval model exists
  // — see reelfix-proof-report.ts's header comment on why Task #2.19
  // deliberately didn't build one). "This ReelFix engagement is
  // complete" overclaimed that human sign-off. State only what actually
  // happened: the scan ran; the recommendation below (reused verbatim
  // from the verification's own customer-safe text) says what to do next.
  return {
    headline: "Verification scan completed.",
    explanation:
      verificationReport.recommendation?.explanation ||
      "No further action is needed at this time."
  };
}

/** Pure. No I/O, no AI call — every field is composed from its input. */
export function buildReelFixProofReport(
  input: ReelFixProofReportInput
): ReelFixProofReport {
  const { comparison } = input;
  return {
    businessName: input.businessName,
    websiteUrl: input.websiteUrl,
    verificationDate: input.verificationDate,
    whatChanged: composeWhatChanged(comparison),
    improvementsCompleted: comparison.resolved.map((item) => ({
      area: item.area,
      whatWasWrong: item.whatWeFound,
      nowImproved: "This was not detected again in the verification scan."
    })),
    stillToReview: [...comparison.remaining, ...comparison.needsReview],
    newIssues: comparison.newIssues,
    whatIsWorking: comparison.strengths.slice(0, MAX_STRENGTHS_SHOWN),
    technicalHealth: comparison.technicalHealthScore,
    nextRecommendation: composeNextRecommendation(input.verificationReport)
  };
}

// -- Printable HTML rendering -------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

function renderIssueList(items: ReelFixProofReportIssue[]): string {
  if (!items.length) return `<p class="empty">None.</p>`;
  return `<ul class="issue-list">${items
    .map(
      (item) =>
        `<li><span class="area">${escapeHtml(item.area)}</span><span class="text">${escapeHtml(item.whatWeFound)}</span></li>`
    )
    .join("")}</ul>`;
}

/**
 * Turns a ReelFixProofReport into a single, self-contained, print-
 * friendly HTML page. No external stylesheets/scripts/fonts — every
 * value that came from scanned page content or business-entered text is
 * escaped, since it may contain characters that would otherwise be
 * interpreted as markup.
 */
export function renderReelFixProofReportHtml(report: ReelFixProofReport): string {
  const { technicalHealth } = report;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ReelFix Result — ${escapeHtml(report.businessName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1f2320;
    background: #fff;
    max-width: 720px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
    line-height: 1.5;
  }
  header { border-bottom: 2px solid #1f2320; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .masthead { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6156; }
  h1 { font-size: 1.5rem; margin: 0.3rem 0 0.6rem; }
  .meta { font-size: 0.9rem; color: #4a453e; }
  .meta div { margin-bottom: 0.15rem; }
  .headline {
    font-size: 1.15rem;
    font-weight: 600;
    background: #f3f6f4;
    border-left: 4px solid #2f6f5e;
    padding: 1rem 1.2rem;
    margin: 1.5rem 0 2rem;
  }
  section { margin-bottom: 2rem; }
  h2 { font-size: 1.05rem; border-bottom: 1px solid #d8d3c8; padding-bottom: 0.4rem; margin-bottom: 0.8rem; }
  .improvement { margin-bottom: 1rem; padding-left: 0.9rem; border-left: 3px solid #2f6f5e; }
  .improvement .area { font-weight: 600; display: block; }
  .improvement .before { color: #4a453e; margin: 0.2rem 0; }
  .improvement .after { color: #2f6f5e; margin: 0; }
  .issue-list { list-style: none; padding: 0; margin: 0; }
  .issue-list li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
  .issue-list .area { font-weight: 600; display: block; font-size: 0.85rem; color: #6b6156; }
  .issue-list .text { display: block; }
  .empty { color: #6b6156; font-style: italic; }
  .strengths { padding-left: 1.2rem; }
  .score-section { background: #f7f6f2; border-radius: 6px; padding: 1rem 1.2rem; font-size: 0.9rem; color: #4a453e; }
  .score-section h2 { border-bottom: none; margin-bottom: 0.4rem; font-size: 0.95rem; }
  .score-row { font-family: ui-monospace, monospace; }
  .recommendation { border: 1px solid #d8d3c8; border-radius: 6px; padding: 1rem 1.2rem; }
  .recommendation .headline { background: none; border: none; padding: 0; margin: 0 0 0.4rem; font-size: 1rem; }
  footer { margin-top: 2.5rem; font-size: 0.75rem; color: #948c7d; }
  @media print {
    body { padding: 0; max-width: none; }
    section { break-inside: avoid; }
  }
</style>
</head>
<body>
<header>
  <div class="masthead">ReelHaus — ReelFix Result</div>
  <h1>${escapeHtml(report.businessName)}</h1>
  <div class="meta">
    <div>Website: ${escapeHtml(report.websiteUrl)}</div>
    <div>Verification date: ${escapeHtml(formatDate(report.verificationDate))}</div>
  </div>
</header>

<div class="headline">${escapeHtml(report.whatChanged)}</div>

<section>
  <h2>Improvements completed</h2>
  ${
    report.improvementsCompleted.length
      ? report.improvementsCompleted
          .map(
            (item) => `<div class="improvement">
      <span class="area">${escapeHtml(item.area)}</span>
      <p class="before">Before: ${escapeHtml(item.whatWasWrong)}</p>
      <p class="after">Now: ${escapeHtml(item.nowImproved)}</p>
    </div>`
          )
          .join("")
      : `<p class="empty">No verified improvements yet.</p>`
  }
</section>

<section>
  <h2>Still to review</h2>
  ${renderIssueList(report.stillToReview)}
</section>

<section>
  <h2>New issues</h2>
  ${renderIssueList(report.newIssues)}
</section>

<section>
  <h2>What is already working</h2>
  ${
    report.whatIsWorking.length
      ? `<ul class="strengths">${report.whatIsWorking.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<p class="empty">Not highlighted in this report.</p>`
  }
</section>

<section class="score-section">
  <h2>Technical Website Health</h2>
  <div class="score-row">Before: ${technicalHealth.before ?? "—"}/100</div>
  <div class="score-row">After: ${technicalHealth.after ?? "—"}/100</div>
</section>

<section class="recommendation">
  <h2>Next recommendation</h2>
  <p class="headline">${escapeHtml(report.nextRecommendation.headline)}</p>
  <p>${escapeHtml(report.nextRecommendation.explanation)}</p>
</section>

<footer>Prepared by ReelHaus. Internal document — for delivery to the business by a ReelHaus reviewer.</footer>
</body>
</html>`;
}
