// ReelScan v1 — a controlled, internal digital-presence diagnosis.
//
// Pipeline: deterministic Website Guardian findings + a small factual
// content-evidence pass -> Task #2 EvidenceRecords -> Workers AI reasoning
// over ONLY that evidence -> schema-validated findings, persisted through
// the audit ledger's lineage invariants -> a deterministic, explainable
// score and a Fix-before-Build recommendation.
//
// This module never calls the AI model with anything but the evidence it
// was handed, and never trusts AI output without validating it end to end.
import {
  type AiChatMessage,
  type WorkersAiBinding,
  WorkersAiService
} from "./ai-service";
import {
  type AiAnalysisRun,
  type AuditLedgerService,
  type EvidenceRecord,
  type FindingKind,
  type FindingRecord
} from "./audit-ledger";
import type { EvidenceConfidence } from "./sales-types";
import { analyzeReelHaus, type AuditReport, type Severity } from "./website-analysis";

// Centralized so the model/version can change later without touching the
// pipeline that calls it.
export const REELSCAN_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
export const REELSCAN_PROMPT_VERSION = "reelscan-v1";
export const REELSCAN_SCHEMA_VERSION = "reelscan-findings-v1";
export const REELSCAN_AI_TIMEOUT_MS = 30_000;

export const REELSCAN_CATEGORIES = [
  "positioning",
  "trust",
  "action_path",
  "service_clarity",
  "technical",
  "mobile",
  "consistency"
] as const;
export type ReelScanCategory = (typeof REELSCAN_CATEGORIES)[number];

const REELSCAN_SEVERITIES: readonly Severity[] = [
  "critical",
  "important",
  "optional"
];
const REELSCAN_KINDS: readonly FindingKind[] = ["strength", "issue"];

export type ReelScanRecommendedAction =
  | "no_immediate_change"
  | "ReelFix"
  | "ReelBuild"
  | "ReelCare";

export class ReelScanValidationError extends Error {}

// -- Client #0 target ---------------------------------------------------

export const CLIENT_ZERO_PAGES = [
  { url: "https://reelhaus.de/fr/", language: "fr" },
  { url: "https://reelhaus.de/ar/", language: "ar" }
] as const;

const CONTENT_FETCH_TIMEOUT_MS = 12_000;
const MAX_CONTENT_BYTES = 2_000_000;
const HERO_EXCERPT_LENGTH = 320;
const SERVICE_TERMS = ["ReelScan", "ReelFix", "ReelBuild", "ReelCare"] as const;
const ACTION_LINK_PATTERN =
  /contact|devis|rendez-vous|réserv|reserv|demande|اتصل|تواصل/i;

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html: string, pattern: RegExp): string {
  return stripHtml(html.match(pattern)?.[0] || "");
}

interface ContentSignals {
  pageUrl: string;
  title: string;
  metaDescription: string;
  primaryHeading: string;
  heroExcerpt: string;
  actionLinks: string[];
  serviceTermMentions: Array<{ term: string; excerpt: string | null }>;
}

function extractContentSignals(pageUrl: string, html: string): ContentSignals {
  const title = firstMatch(html, /<title\b[^>]*>[\s\S]*?<\/title>/i);
  const descriptionTag =
    [...html.matchAll(/<meta\b[^>]*>/gi)]
      .map((match) => match[0])
      .find((tag) => /name\s*=\s*["']description["']/i.test(tag)) || "";
  const metaDescription = stripHtml(
    descriptionTag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.[1] ||
      descriptionTag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.[2] ||
      ""
  );
  const primaryHeading = firstMatch(html, /<h1\b[^>]*>[\s\S]*?<\/h1>/i);
  const bodyText = stripHtml(html);
  const heroExcerpt = bodyText.slice(0, HERO_EXCERPT_LENGTH);

  const links = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(
    (match) => match[0]
  );
  const actionLinks = links
    .filter((tag) => {
      const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const hrefValue = href?.[1] || href?.[2] || "";
      const text = stripHtml(tag);
      return (
        /^mailto:|^tel:|wa\.me|whatsapp\.com/i.test(hrefValue) ||
        ACTION_LINK_PATTERN.test(`${text} ${hrefValue}`)
      );
    })
    .map((tag) => {
      const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      return href?.[1] || href?.[2] || stripHtml(tag);
    })
    .filter(Boolean);

  const serviceTermMentions = SERVICE_TERMS.map((term) => {
    const index = bodyText.indexOf(term);
    if (index === -1) return { term, excerpt: null };
    const start = Math.max(0, index - 60);
    const excerpt = bodyText.slice(start, index + term.length + 60);
    return { term, excerpt };
  });

  return {
    pageUrl,
    title,
    metaDescription,
    primaryHeading,
    heroExcerpt,
    actionLinks: [...new Set(actionLinks)],
    serviceTermMentions
  };
}

function contentEvidenceInputs(
  scanId: string,
  signals: ContentSignals,
  capturedAt: string
): Array<Omit<EvidenceRecord, "id">> {
  const collector = "reelscan-v1@content-evidence";
  const base = {
    scanId,
    sourceType: "html_static",
    sourceUrl: signals.pageUrl,
    capturedAt,
    collector
  };
  const records: Array<Omit<EvidenceRecord, "id">> = [
    {
      ...base,
      observationType: "page_title",
      observation: signals.title
        ? `The <title> element reads: "${signals.title}".`
        : "No <title> element text was found on this page."
    },
    {
      ...base,
      observationType: "meta_description",
      observation: signals.metaDescription
        ? `The meta description reads: "${signals.metaDescription}".`
        : "No meta description was found on this page."
    },
    {
      ...base,
      observationType: "primary_heading",
      observation: signals.primaryHeading
        ? `The first <h1> text reads: "${signals.primaryHeading}".`
        : "No <h1> text was found on this page."
    },
    {
      ...base,
      observationType: "hero_text_excerpt",
      observation: signals.heroExcerpt
        ? `The first ${signals.heroExcerpt.length} characters of visible page text read: "${signals.heroExcerpt}".`
        : "No visible body text was extracted from this page."
    },
    {
      ...base,
      observationType: "action_link_signals",
      observation: signals.actionLinks.length
        ? `${signals.actionLinks.length} link(s) were detected whose href or text matched contact/action patterns (mailto, tel, WhatsApp, or contact/devis/réservation-style wording): ${signals.actionLinks.slice(0, 10).join(", ")}.`
        : "No link on this page matched contact or action patterns (searched for mailto:, tel:, WhatsApp links, and contact/devis/réservation-style wording)."
    }
  ];
  for (const mention of signals.serviceTermMentions)
    records.push({
      ...base,
      observationType: `service_term:${mention.term}`,
      observation: mention.excerpt
        ? `The term "${mention.term}" appears on this page. Surrounding text: "${mention.excerpt}".`
        : `The term "${mention.term}" was not found in this page's visible text.`
    });
  return records;
}

export async function collectClientZeroContentEvidence(
  fetcher: typeof fetch,
  scanId: string
): Promise<Array<Omit<EvidenceRecord, "id">>> {
  const results: Array<Omit<EvidenceRecord, "id">> = [];
  for (const page of CLIENT_ZERO_PAGES) {
    try {
      const response = await fetcher(page.url, {
        headers: {
          "user-agent": "ReelHaus-Manager/1.0 reelscan-v1-client-zero",
          accept: "text/html"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(CONTENT_FETCH_TIMEOUT_MS)
      });
      if (!response.ok) continue;
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_CONTENT_BYTES) continue;
      const html = await response.text();
      const capturedAt = new Date().toISOString();
      const signals = extractContentSignals(page.url, html);
      results.push(...contentEvidenceInputs(scanId, signals, capturedAt));
    } catch {
      // A failed content-signal fetch is not evidence; the Website Guardian
      // pass already records availability failures as technical findings.
    }
  }
  return results;
}

// -- Technical evidence, reused from the existing Website Guardian ------

export function technicalEvidenceFromGuardianReport(
  report: AuditReport
): Array<Omit<EvidenceRecord, "id">> {
  const checkedAtByPage = new Map(
    report.pages.map((page) => [page.url, page.checkedAt])
  );
  return report.findings.map((finding) => ({
    scanId: report.id,
    sourceType: "html_static",
    sourceUrl: finding.page,
    observationType: finding.category,
    observation: `${finding.title}: ${finding.detail}`,
    capturedAt: checkedAtByPage.get(finding.page) || report.createdAt,
    collector: "website-analysis@analyzeReelHaus",
    metadata: {
      severity: finding.severity,
      evidenceType: finding.evidence,
      reportId: report.id
    }
  }));
}

// -- AI reasoning ---------------------------------------------------------

interface RawReelScanFinding {
  title: unknown;
  category: unknown;
  severity: unknown;
  priority: unknown;
  summary: unknown;
  evidenceIds: unknown;
  confidence?: unknown;
  kind?: unknown;
}

export interface ValidatedReelScanFinding {
  title: string;
  category: ReelScanCategory;
  severity: Severity;
  priority: number;
  summary: string;
  evidenceIds: string[];
  confidence: EvidenceConfidence;
  kind: FindingKind;
}

function confidenceBucket(value: number): EvidenceConfidence {
  if (value >= 0.75) return "High";
  if (value >= 0.4) return "Medium";
  return "Low";
}

export function buildReelScanPrompt(
  evidence: EvidenceRecord[]
): AiChatMessage[] {
  const system = `You are ReelScan v1, a digital-presence analyst for a web agency.

Treat the supplied evidence as the complete factual universe for this analysis. Do not invent missing facts. If something cannot be established from evidence, do not claim it. Do not reference SEO rankings, traffic, revenue, or conversion rates unless that exact fact appears in the evidence.

Respond with ONLY a JSON object of this exact shape, no prose outside the JSON:
{"findings": [
  {
    "title": "short finding title",
    "category": one of ${JSON.stringify(REELSCAN_CATEGORIES)},
    "severity": one of ${JSON.stringify(REELSCAN_SEVERITIES)},
    "priority": integer 1 (most urgent) to 5 (least urgent),
    "summary": "1-3 sentences, grounded only in the cited evidence",
    "evidenceIds": ["one or more evidence id strings from the supplied evidence — never invent an id"],
    "confidence": number from 0.0 to 1.0,
    "kind": one of ${JSON.stringify(REELSCAN_KINDS)}
  }
]}

Include both "issue" findings (supported problems) and "strength" findings (supported positives) when the evidence supports them. Every finding must cite at least one evidenceId that exists in the evidence you were given. Do not fabricate praise or problems.`;

  const evidencePayload = evidence.map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl,
    observationType: item.observationType,
    observation: item.observation
  }));

  const user = `Evidence (the complete factual universe for this scan):\n${JSON.stringify(evidencePayload)}\n\nAnalyze findability/identity, trust, action/conversion path, service clarity, and mobile/technical customer-journey friction. Return the JSON object now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function parseReelScanAiResponse(
  raw: string,
  allowedEvidenceIds: ReadonlySet<string>
): ValidatedReelScanFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReelScanValidationError("AI response was not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  )
    throw new ReelScanValidationError(
      'AI response did not contain a "findings" array'
    );

  const rawFindings = (parsed as { findings: RawReelScanFinding[] }).findings;
  const validated: ValidatedReelScanFinding[] = [];
  for (const [index, item] of rawFindings.entries()) {
    const prefix = `findings[${index}]`;
    if (typeof item.title !== "string" || !item.title.trim())
      throw new ReelScanValidationError(`${prefix}.title is missing or empty`);
    if (
      typeof item.category !== "string" ||
      !REELSCAN_CATEGORIES.includes(item.category as ReelScanCategory)
    )
      throw new ReelScanValidationError(`${prefix}.category is invalid`);
    if (
      typeof item.severity !== "string" ||
      !REELSCAN_SEVERITIES.includes(item.severity as Severity)
    )
      throw new ReelScanValidationError(`${prefix}.severity is invalid`);
    if (
      typeof item.priority !== "number" ||
      !Number.isInteger(item.priority) ||
      item.priority < 1 ||
      item.priority > 5
    )
      throw new ReelScanValidationError(
        `${prefix}.priority must be an integer between 1 and 5`
      );
    if (typeof item.summary !== "string" || !item.summary.trim())
      throw new ReelScanValidationError(
        `${prefix}.summary is missing or empty`
      );
    if (
      !Array.isArray(item.evidenceIds) ||
      item.evidenceIds.length === 0 ||
      item.evidenceIds.some((id) => typeof id !== "string")
    )
      throw new ReelScanValidationError(
        `${prefix}.evidenceIds must be a non-empty array of strings`
      );
    const evidenceIds = item.evidenceIds as string[];
    const unknownIds = evidenceIds.filter((id) => !allowedEvidenceIds.has(id));
    if (unknownIds.length)
      throw new ReelScanValidationError(
        `${prefix} references evidence IDs outside this analysis run: ${unknownIds.join(", ")}`
      );
    if (
      item.confidence !== undefined &&
      (typeof item.confidence !== "number" ||
        item.confidence < 0 ||
        item.confidence > 1)
    )
      throw new ReelScanValidationError(
        `${prefix}.confidence must be a number between 0 and 1`
      );
    if (
      typeof item.kind !== "string" ||
      !REELSCAN_KINDS.includes(item.kind as FindingKind)
    )
      throw new ReelScanValidationError(`${prefix}.kind is invalid`);

    validated.push({
      title: item.title.trim(),
      category: item.category as ReelScanCategory,
      severity: item.severity as Severity,
      priority: item.priority,
      summary: item.summary.trim(),
      evidenceIds: [...new Set(evidenceIds)],
      confidence: confidenceBucket(
        typeof item.confidence === "number" ? item.confidence : 0.5
      ),
      kind: item.kind as FindingKind
    });
  }
  return validated;
}

// -- Deterministic scoring --------------------------------------------------

export const REELSCAN_SEVERITY_DEDUCTIONS: Record<Severity, number> = {
  critical: 25,
  important: 10,
  optional: 3
};

export function scoreImpactFor(kind: FindingKind, severity: Severity): number {
  return kind === "strength" ? 0 : -REELSCAN_SEVERITY_DEDUCTIONS[severity];
}

export interface ReelScanScore {
  score: number;
  breakdown: Array<{ findingId: string; title: string; points: number }>;
}

export function calculateReelScanScore(
  findings: FindingRecord[]
): ReelScanScore {
  const contributing = findings.filter(
    (finding) => (finding.scoreImpact || 0) !== 0
  );
  const total = contributing.reduce(
    (sum, finding) => sum + (finding.scoreImpact || 0),
    0
  );
  return {
    score: Math.max(0, Math.min(100, 100 + total)),
    breakdown: contributing.map((finding) => ({
      findingId: finding.id,
      title: finding.title,
      points: finding.scoreImpact || 0
    }))
  };
}

// -- Fix vs Build recommendation --------------------------------------------

const FOUNDATIONAL_CATEGORIES: ReadonlySet<ReelScanCategory> = new Set([
  "positioning",
  "service_clarity"
]);

export interface ReelScanRecommendation {
  action: ReelScanRecommendedAction;
  reasons: string[];
}

export function recommendReelScanAction(
  findings: FindingRecord[]
): ReelScanRecommendation {
  const issues = findings.filter((finding) => finding.kind === "issue");
  const criticalFoundational = issues.filter(
    (finding) =>
      finding.severity === "critical" &&
      FOUNDATIONAL_CATEGORIES.has(finding.category as ReelScanCategory)
  );
  if (criticalFoundational.length)
    return {
      action: "ReelBuild",
      reasons: criticalFoundational.map(
        (finding) =>
          `Critical, foundational issue in ${finding.category}: ${finding.title}`
      )
    };

  const repairable = issues.filter(
    (finding) => finding.severity === "critical" || finding.severity === "important"
  );
  if (repairable.length)
    return {
      action: "ReelFix",
      reasons: [
        "Fix before Build: the site has specific, repairable friction rather than a foundational problem.",
        ...repairable.map(
          (finding) => `${finding.severity} issue: ${finding.title}`
        )
      ]
    };

  const optionalIssues = issues.filter((finding) => finding.severity === "optional");
  if (optionalIssues.length >= 3)
    return {
      action: "ReelCare",
      reasons: [
        `${optionalIssues.length} minor, evidence-supported issues suggest ongoing upkeep rather than a one-off fix.`,
        ...optionalIssues.map((finding) => finding.title)
      ]
    };

  return {
    action: "no_immediate_change",
    reasons: [
      "No critical or important evidence-supported issues were found."
    ]
  };
}

// -- Orchestration -----------------------------------------------------------

export interface ReelScanV1Result {
  scanId: string;
  targetUrls: string[];
  evidence: EvidenceRecord[];
  analysisRun: AiAnalysisRun;
  findings: FindingRecord[];
  score: ReelScanScore | null;
  recommendation: ReelScanRecommendation;
  reviewStatus: "needs_review";
}

export interface ReelScanV1Deps {
  ai: WorkersAiBinding | undefined;
  auditLedger: AuditLedgerService;
  fetcher: typeof fetch;
}

export async function runReelScanV1ClientZero(
  deps: ReelScanV1Deps
): Promise<{ result: ReelScanV1Result; report: AuditReport }> {
  const report = await analyzeReelHaus(deps.fetcher);
  const scanId = report.id;

  const evidenceInputs = [
    ...technicalEvidenceFromGuardianReport(report),
    ...(await collectClientZeroContentEvidence(deps.fetcher, scanId))
  ];
  const evidence = evidenceInputs.map((input) =>
    deps.auditLedger.recordEvidence(input)
  );
  const evidenceIds = evidence.map((item) => item.id);

  const run = deps.auditLedger.startAiAnalysisRun({
    scanId,
    provider: "cloudflare-workers-ai",
    model: REELSCAN_MODEL,
    promptVersion: REELSCAN_PROMPT_VERSION,
    schemaVersion: REELSCAN_SCHEMA_VERSION,
    evidenceIds
  });

  let findings: FindingRecord[] = [];
  try {
    const service = new WorkersAiService(deps.ai, REELSCAN_MODEL);
    const response = await service.runChatPrompt(
      buildReelScanPrompt(evidence),
      {
        temperature: 0,
        maxTokens: 2000,
        responseFormat: { type: "json_object" }
      },
      REELSCAN_AI_TIMEOUT_MS
    );
    const validated = parseReelScanAiResponse(
      response.response,
      new Set(evidenceIds)
    );
    findings = validated.map((finding) =>
      deps.auditLedger.recordFinding({
        scanId,
        analysisRunId: run.id,
        kind: finding.kind,
        title: finding.title,
        category: finding.category,
        severity: finding.severity,
        priority: finding.priority,
        summary: finding.summary,
        evidenceIds: finding.evidenceIds,
        confidence: finding.confidence,
        scoreImpact: scoreImpactFor(finding.kind, finding.severity)
      })
    );
    deps.auditLedger.completeAiAnalysisRun(run.id, { status: "completed" });
  } catch (error) {
    deps.auditLedger.completeAiAnalysisRun(run.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return {
      report,
      result: {
        scanId,
        targetUrls: [...report.targets],
        evidence,
        analysisRun: deps.auditLedger.getScanAuditTrail(scanId).analysisRuns.at(-1)!,
        findings: [],
        score: null,
        recommendation: {
          action: "no_immediate_change",
          reasons: ["AI analysis failed; no validated findings are available."]
        },
        reviewStatus: "needs_review"
      }
    };
  }

  return {
    report,
    result: {
      scanId,
      targetUrls: [...report.targets],
      evidence,
      analysisRun: deps.auditLedger.getScanAuditTrail(scanId).analysisRuns.at(-1)!,
      findings,
      score: calculateReelScanScore(findings),
      recommendation: recommendReelScanAction(findings),
      reviewStatus: "needs_review"
    }
  };
}
