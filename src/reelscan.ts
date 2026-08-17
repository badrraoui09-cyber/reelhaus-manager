// ReelScan v1 — a controlled, internal digital-presence diagnosis.
//
// Pipeline: deterministic Website Guardian findings + a small factual
// content-evidence pass -> Task #2 EvidenceRecords -> Workers AI reasoning
// over ONLY that evidence -> schema-validated findings -> a deterministic
// post-validation calibration pass (downgrade uncertainty, consolidate
// duplicates, guarantee verified defects aren't silently dropped) ->
// persisted through the audit ledger's lineage invariants -> a
// deterministic, explainable score and a Fix-before-Build recommendation.
//
// This module never calls the AI model with anything but the evidence it
// was handed, and never trusts AI output without validating it end to end.
// It also never trusts the AI's *interpretation* of that evidence blindly:
// scoring and duplicate-handling are deterministic, not prompt-only.
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
import {
  analyzeReelHaus,
  type AuditReport,
  type EvidenceType,
  type Severity
} from "./website-analysis";

// Centralized so the model/version can change later without touching the
// pipeline that calls it.
export const REELSCAN_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const REELSCAN_PROMPT_VERSION = "reelscan-v1";
export const REELSCAN_SCHEMA_VERSION = "reelscan-findings-v1";
// A real inference over ~20+ evidence records regularly exceeds the
// ai-service.ts default (10s, tuned for the tiny Task #1 health check).
// Dedicated to ReelScan only — passed explicitly into runChatPrompt().
export const REELSCAN_AI_TIMEOUT_MS = 60_000;

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
// AI only ever emits "strength" or "issue" — "note" is a deterministic,
// post-validation classification (see downgradeUncertainIssues) and is
// intentionally not part of the schema offered to the model.
const REELSCAN_AI_KINDS: readonly FindingKind[] = ["strength", "issue"];

// Cloudflare's JSON Schema mode (response_format: { type: "json_schema" }).
// Best-effort — the provider notes this cannot guarantee compliance, so
// parseReelScanAiResponse() re-validates every field independently.
export const REELSCAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          category: { type: "string", enum: [...REELSCAN_CATEGORIES] },
          severity: { type: "string", enum: [...REELSCAN_SEVERITIES] },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          summary: { type: "string" },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          kind: { type: "string", enum: [...REELSCAN_AI_KINDS] }
        },
        required: [
          "title",
          "category",
          "severity",
          "priority",
          "summary",
          "evidenceIds",
          "kind"
        ]
      }
    }
  },
  required: ["findings"]
} as const;

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
  /contact|devis|rendez-vous|réserv|reserv|demande|audit|اتصل|تواصل/i;

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

// -- Action-link evidence (Problem 3) ---------------------------------------
//
// The collector previously deduplicated CTA occurrences by destination
// before recording evidence, so three visible buttons pointing at the same
// #audit anchor became "1 link detected" — indistinguishable from a page
// with genuinely one weak, hard-to-find action. Total occurrences and
// unique destinations are now recorded as separate facts, with a
// deterministic action type per occurrence, so the AI (and a human) can
// tell "one clear primary conversion path" from "hard to find any action".

type ActionLinkType =
  | "email"
  | "phone"
  | "whatsapp"
  | "anchor"
  | "contact_page"
  | "other";

interface ActionLinkOccurrence {
  href: string;
  text: string;
  type: ActionLinkType;
}

function classifyActionLink(href: string): ActionLinkType {
  if (/^mailto:/i.test(href)) return "email";
  if (/^tel:/i.test(href)) return "phone";
  if (/wa\.me|whatsapp\.com/i.test(href)) return "whatsapp";
  if (href.startsWith("#")) return "anchor";
  if (ACTION_LINK_PATTERN.test(href)) return "contact_page";
  return "other";
}

function extractActionLinkOccurrences(links: string[]): ActionLinkOccurrence[] {
  return links
    .filter((tag) => {
      const hrefMatch = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
      const text = stripHtml(tag);
      return (
        /^mailto:|^tel:|wa\.me|whatsapp\.com/i.test(href) ||
        ACTION_LINK_PATTERN.test(`${text} ${href}`)
      );
    })
    .map((tag) => {
      const hrefMatch = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
      const text = stripHtml(tag);
      return { href, text, type: classifyActionLink(href) };
    });
}

interface ContentSignals {
  pageUrl: string;
  title: string;
  metaDescription: string;
  primaryHeading: string;
  heroExcerpt: string;
  actionOccurrences: ActionLinkOccurrence[];
  uniqueActionDestinations: string[];
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
  const actionOccurrences = extractActionLinkOccurrences(links);
  const uniqueActionDestinations = [
    ...new Set(actionOccurrences.map((occurrence) => occurrence.href))
  ].filter(Boolean);

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
    actionOccurrences,
    uniqueActionDestinations,
    serviceTermMentions
  };
}

function contentEvidenceInputs(
  scanId: string,
  signals: ContentSignals,
  capturedAt: string
): Array<Omit<EvidenceRecord, "id">> {
  const collector = "reelscan-v1@content-evidence";
  // Every content-evidence record is a direct factual detection, not an
  // inference or a "couldn't check" disclaimer — unlike some Website
  // Guardian findings (see technicalEvidenceFromGuardianReport).
  const base = {
    scanId,
    sourceType: "html_static",
    sourceUrl: signals.pageUrl,
    capturedAt,
    collector,
    metadata: { verification: "verified" as EvidenceType }
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
      observation: signals.actionOccurrences.length
        ? `${signals.actionOccurrences.length} action-oriented link occurrence(s) were detected on this page (mailto/tel/WhatsApp links, or links/text matching contact/devis/réservation-style wording), resolving to ${signals.uniqueActionDestinations.length} unique destination(s). Occurrences: ${signals.actionOccurrences
            .slice(0, 10)
            .map(
              (occurrence) =>
                `"${occurrence.text || occurrence.href}" -> ${occurrence.href} (${occurrence.type})`
            )
            .join("; ")}. A small number of unique destinations reached by several visible elements is a single clear conversion path, not a low link count.`
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
      // "verified" = the collector actually confirmed this fact.
      // "inference" = a heuristic signal, OR (as with the always-on
      // responsive-layout note) a plain disclaimer that something could
      // not be checked at all. Neither is proof of a defect on its own —
      // see downgradeUncertainIssues().
      verification: finding.evidence,
      reportId: report.id
    }
  }));
}

const GUARDIAN_COLLECTOR = "website-analysis@analyzeReelHaus";

function evidenceVerification(evidence: EvidenceRecord): EvidenceType {
  return evidence.metadata?.verification === "inference" ? "inference" : "verified";
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

// Workers AI is asked for a 0.0-1.0 confidence, but every other confidence
// value in this repository (sales-types.ts EvidenceConfidence, used
// throughout business-workspace.ts etc.) is a High/Medium/Low tri-level —
// there is no raw-float concept anywhere else in the app. This bucketing is
// an intentional, deliberate mapping onto that existing convention, not an
// accident: exported and boundary-tested so the thresholds are pinned.
export function confidenceBucket(value: number): EvidenceConfidence {
  if (value >= 0.75) return "High";
  if (value >= 0.4) return "Medium";
  return "Low";
}

export function buildReelScanPrompt(
  evidence: EvidenceRecord[]
): AiChatMessage[] {
  const system = `You are ReelScan v1, a digital-presence analyst for a web agency.

Treat the supplied evidence as the complete factual universe for this analysis. Do not invent missing facts. If something cannot be established from evidence, do not claim it. Do not reference SEO rankings, traffic, revenue, or conversion rates unless that exact fact appears in the evidence.

Each evidence item has a "verification" field. "inference" means the collector could not actually verify this fact (a heuristic guess, or a plain statement that something was not tested) — it is NOT proof of a defect. Do not create an "issue" finding whose only support is inference-only evidence; at most note it as context.

When evidence distinguishes total link occurrences from unique destinations, a small number of unique destinations reached by several visible elements is a strength (one clear conversion path), not a weakness. Only report an action-path issue when the evidence itself shows an actual absence of, or demonstrated difficulty finding, a next action.

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
    "kind": one of ${JSON.stringify(REELSCAN_AI_KINDS)}
  }
]}

Include both "issue" findings (supported problems) and "strength" findings (supported positives) when the evidence supports them. Every finding must cite at least one evidenceId that exists in the evidence you were given. Do not fabricate praise or problems. Do not create separate findings for the same underlying signal repeated only because it appears on both the French and Arabic page — the AI's output is deterministically consolidated afterward, but citing all matching evidenceIds in one finding is preferred over duplicating it.`;

  const evidencePayload = evidence.map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl,
    observationType: item.observationType,
    observation: item.observation,
    verification: evidenceVerification(item)
  }));

  const user = `Evidence (the complete factual universe for this scan):\n${JSON.stringify(evidencePayload)}\n\nAnalyze findability/identity, trust, action/conversion path, service clarity, and mobile/technical customer-journey friction. Return the JSON object now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// Accepts either a raw JSON string or an already-parsed object/array —
// Workers AI's structured mode can return `.response` as either, depending
// on the model. Provider-side JSON Schema is best-effort only, so every
// field is still validated here regardless of which shape arrived.
export function parseReelScanAiResponse(
  raw: unknown,
  allowedEvidenceIds: ReadonlySet<string>
): ValidatedReelScanFinding[] {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ReelScanValidationError("AI response was not valid JSON");
    }
  } else {
    parsed = raw;
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
      !REELSCAN_AI_KINDS.includes(item.kind as FindingKind)
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

// -- Deterministic calibration (Problems 1, 2, 4, 5) -------------------------
//
// The AI is instructed not to score uncertainty and not to duplicate across
// categories/locales, but instructions are not guarantees. Everything below
// re-derives the correct outcome from evidence and structure, independent
// of whether the model actually complied.

// Problem 1: evidence whose only content is "not verified / not tested /
// manual review required / collector cannot determine" must not become a
// scored defect merely because the AI phrased it as one. A finding is only
// downgraded when EVERY evidence ID it cites is inference-only — a finding
// backed by at least one verified fact keeps its "issue" classification.
export function downgradeUncertainIssues(
  findings: ValidatedReelScanFinding[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): ValidatedReelScanFinding[] {
  return findings.map((finding) => {
    if (finding.kind !== "issue") return finding;
    const evidenceItems = finding.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRecord => Boolean(item));
    const allUnverified =
      evidenceItems.length > 0 &&
      evidenceItems.every((item) => evidenceVerification(item) === "inference");
    if (!allUnverified) return finding;
    return {
      ...finding,
      kind: "note",
      summary: `${finding.summary} (Reclassified: based only on unverified/manual-review evidence, not a confirmed defect — see cited evidence for the collector's limitation.)`
    };
  });
}

// Problems 2 & 5: one root problem must not deduct score multiple times
// merely because it was phrased under several categories, or because the
// same structural signal exists once per language page. Findings of the
// same kind whose evidence maps to the exact same set of evidence
// "observationType"s (locale-independent — e.g. FR and AR responsive
// evidence both have observationType "responsive") are merged into one,
// keeping every original evidence ID for lineage.
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  important: 2,
  optional: 1
};

function evidenceTypeSetKey(
  finding: ValidatedReelScanFinding,
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): string {
  const types = new Set(
    finding.evidenceIds.map(
      (id) => evidenceById.get(id)?.observationType || "unknown"
    )
  );
  return [...types].sort().join("+");
}

function pickRepresentative(
  group: ValidatedReelScanFinding[]
): ValidatedReelScanFinding {
  return [...group].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.priority - b.priority
  )[0];
}

export function consolidateFindings(
  findings: ValidatedReelScanFinding[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): ValidatedReelScanFinding[] {
  const groups = new Map<string, ValidatedReelScanFinding[]>();
  for (const finding of findings) {
    const key = `${finding.kind}::${evidenceTypeSetKey(finding, evidenceById)}`;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  const consolidated: ValidatedReelScanFinding[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }
    const representative = pickRepresentative(group);
    const evidenceIds = [...new Set(group.flatMap((item) => item.evidenceIds))];
    consolidated.push({
      ...representative,
      evidenceIds,
      summary: `${representative.summary} (Consolidated from ${group.length} equivalent findings across categories/locales; all evidence retained.)`
    });
  }
  return consolidated;
}

// Task #3D calibration follow-up: a verified Website Guardian defect's
// severity is ground truth. The AI may cite that evidence in a finding, but
// it must never be able to quietly downgrade it — e.g. reporting a verified
// "important" form-labeling defect as "optional". For every surviving
// "issue" finding, the strongest severity among the verified (not
// inference) Guardian defect evidence it cites becomes a floor: the final
// severity is raised to at least that floor, never lowered by it. Findings
// with no such evidence, or only inference/manual-review evidence, are
// left exactly as the AI reported them. Notes and strengths are untouched.
function severityFloorFromEvidence(
  evidenceIds: string[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): Severity | null {
  let floor: Severity | null = null;
  for (const id of evidenceIds) {
    const item = evidenceById.get(id);
    if (!item || item.collector !== GUARDIAN_COLLECTOR) continue;
    if (evidenceVerification(item) !== "verified") continue;
    const severity = item.metadata?.severity as Severity | undefined;
    if (!severity) continue;
    if (!floor || SEVERITY_RANK[severity] > SEVERITY_RANK[floor]) floor = severity;
  }
  return floor;
}

export function applySeverityFloor(
  findings: ValidatedReelScanFinding[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>
): ValidatedReelScanFinding[] {
  return findings.map((finding) => {
    if (finding.kind !== "issue") return finding;
    const floor = severityFloorFromEvidence(finding.evidenceIds, evidenceById);
    if (!floor || SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[floor])
      return finding;
    return {
      ...finding,
      severity: floor,
      // Reuses the same severity->priority ceiling deriveDeterministicFindings
      // already applies, so a raised severity can never contradict priority.
      priority: Math.min(finding.priority, priorityForSeverity(floor)),
      summary: `${finding.summary} (Severity raised to ${floor}: verified Website Guardian evidence establishes at least this severity; the AI's original assessment did not.)`
    };
  });
}

// Problem 4: a verified, important-or-worse Website Guardian defect must
// end up in the final finding set even if the AI never mentions it. Only
// evidence the AI's (post-consolidation) issue findings did NOT already
// cite is eligible, so a correctly-reported AI finding is never duplicated.
const DETERMINISTIC_INJECTION_SEVERITIES: ReadonlySet<Severity> = new Set([
  "critical",
  "important"
]);

const GUARDIAN_CATEGORY_TO_REELSCAN: Record<string, ReelScanCategory> = {
  availability: "technical",
  links: "technical",
  metadata: "service_clarity",
  language: "consistency",
  rtl: "technical",
  forms: "action_path",
  responsive: "mobile",
  accessibility: "technical",
  seo: "service_clarity"
};

function mapGuardianCategory(category: string): ReelScanCategory {
  return GUARDIAN_CATEGORY_TO_REELSCAN[category] || "technical";
}

function priorityForSeverity(severity: Severity): number {
  return severity === "critical" ? 1 : severity === "important" ? 2 : 4;
}

export function deriveDeterministicFindings(
  evidence: EvidenceRecord[],
  coveredEvidenceIds: ReadonlySet<string>
): ValidatedReelScanFinding[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const eligible = evidence.filter((item) => {
    if (item.collector !== GUARDIAN_COLLECTOR) return false;
    if (coveredEvidenceIds.has(item.id)) return false;
    if (evidenceVerification(item) !== "verified") return false;
    const severity = item.metadata?.severity as Severity | undefined;
    return Boolean(severity && DETERMINISTIC_INJECTION_SEVERITIES.has(severity));
  });
  if (!eligible.length) return [];

  const candidates: ValidatedReelScanFinding[] = eligible.map((item) => {
    const severity = item.metadata?.severity as Severity;
    return {
      title: item.observation.split(":")[0].trim() || item.observationType,
      category: mapGuardianCategory(item.observationType),
      severity,
      priority: priorityForSeverity(severity),
      summary: item.observation,
      evidenceIds: [item.id],
      confidence: "High",
      kind: "issue"
    };
  });

  // Reuse the exact same locale-consolidation as AI findings: an identical
  // FR + AR structural defect is one finding referencing both evidence IDs.
  return consolidateFindings(candidates, evidenceById);
}

// Problem 8: minimal provenance. A finding produced without an AI analysis
// run behind it is deterministic by construction — this is derived, not a
// new stored column, so it can't drift from the actual persisted lineage.
export function findingOrigin(
  finding: Pick<FindingRecord, "analysisRunId">
): "deterministic" | "ai" {
  return finding.analysisRunId ? "ai" : "deterministic";
}

// -- Deterministic scoring --------------------------------------------------

export const REELSCAN_SEVERITY_DEDUCTIONS: Record<Severity, number> = {
  critical: 25,
  important: 10,
  optional: 3
};

// Only "issue" findings ever deduct. "strength" and "note" (Problem 1)
// always contribute 0 — strengths must never reduce score, and uncertainty
// is not a scored defect.
export function scoreImpactFor(kind: FindingKind, severity: Severity): number {
  return kind === "issue" ? -REELSCAN_SEVERITY_DEDUCTIONS[severity] : 0;
}

// Problem 6: severity is a defect scale. Persisting {kind:"strength",
// severity:"critical"} reads as a critical *problem* to anything consuming
// the raw record. Strengths get `impact` instead, `severity: null` — the
// smallest change that removes the ambiguity without a schema rewrite (the
// AI-facing JSON Schema is untouched; only the persisted/exposed shape for
// strengths differs, translated right here).
function severityToImpact(severity: Severity): "high" | "medium" | "low" {
  if (severity === "critical") return "high";
  if (severity === "important") return "medium";
  return "low";
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

// Operates on whatever `findings` it's given — the orchestrator passes the
// final, post-downgrade/post-consolidation/post-injection set, so this
// function needed no changes to satisfy "recommendation after dedup".
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
  recommendation: ReelScanRecommendation | null;
  reviewStatus: "needs_review" | "analysis_failed";
}

export interface ReelScanV1Deps {
  ai: WorkersAiBinding | undefined;
  auditLedger: AuditLedgerService;
  fetcher: typeof fetch;
}

function persistCandidate(
  auditLedger: AuditLedgerService,
  scanId: string,
  analysisRunId: string | null,
  candidate: ValidatedReelScanFinding
): FindingRecord {
  const isStrength = candidate.kind === "strength";
  return auditLedger.recordFinding({
    scanId,
    analysisRunId,
    kind: candidate.kind,
    title: candidate.title,
    category: candidate.category,
    severity: isStrength ? null : candidate.severity,
    impact: isStrength ? severityToImpact(candidate.severity) : undefined,
    priority: candidate.priority,
    summary: candidate.summary,
    evidenceIds: candidate.evidenceIds,
    confidence: candidate.confidence,
    scoreImpact: scoreImpactFor(candidate.kind, candidate.severity)
  });
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
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

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
    const response = await service.runStructuredPrompt(
      buildReelScanPrompt(evidence),
      {
        temperature: 0,
        maxTokens: 2000,
        responseFormat: {
          type: "json_schema",
          json_schema: REELSCAN_JSON_SCHEMA
        }
      },
      REELSCAN_AI_TIMEOUT_MS
    );
    const rawValidated = parseReelScanAiResponse(
      response.response,
      new Set(evidenceIds)
    );

    const downgraded = downgradeUncertainIssues(rawValidated, evidenceById);
    const consolidated = consolidateFindings(downgraded, evidenceById);
    // Applied after consolidation so the floor is computed from the full,
    // merged evidence set (e.g. FR + AR together), not per pre-merge draft.
    const consolidatedAi = applySeverityFloor(consolidated, evidenceById);
    const coveredEvidenceIds = new Set(
      consolidatedAi
        .filter((finding) => finding.kind === "issue")
        .flatMap((finding) => finding.evidenceIds)
    );
    const deterministic = deriveDeterministicFindings(
      evidence,
      coveredEvidenceIds
    );

    findings = [
      ...consolidatedAi.map((candidate) =>
        persistCandidate(deps.auditLedger, scanId, run.id, candidate)
      ),
      ...deterministic.map((candidate) =>
        persistCandidate(deps.auditLedger, scanId, null, candidate)
      )
    ];
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
        recommendation: null,
        reviewStatus: "analysis_failed"
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
