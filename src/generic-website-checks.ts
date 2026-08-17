// Generic, first-party-agnostic deterministic website checks.
//
// Website Guardian (website-analysis.ts) mixes two things: checks any
// website could be judged by (missing viewport, unlabeled forms, missing
// alt text, ...) and checks that only make sense for reelhaus.de itself
// (required FR+AR hreflang pairing, Arabic RTL, comparing <html lang> to
// a caller-provided expected locale). Client #0 is already calibrated
// against the combined Guardian output and must not change, so this module
// is a deliberately independent implementation of only the generic half,
// safe to run against an arbitrary customer target.
//
// Unlike website-analysis.ts, this module never fetches anything and never
// uses HTMLRewriter — it operates on an HTML string a caller already
// obtained through safe-fetch.ts, using the same regex-based extraction
// style reelscan.ts's extractContentSignals() uses for the same reason
// (works in the Cloudflare Workers runtime, works in plain Node/vitest,
// and — most importantly — issues zero additional network requests, so a
// customer-submitted page can never trigger a second, uncontrolled fetch).
import type { EvidenceRecord } from "./audit-ledger";
import type { EvidenceType, Finding, Severity } from "./website-analysis";

export const GENERIC_CHECKS_COLLECTOR = "reelscan-v1@generic-website-checks";

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(source: string, name: string): string | null {
  const match = source.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? "";
}

function hasAttr(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`, "i").test(source);
}

function finding(
  severity: Severity,
  category: Finding["category"],
  page: string,
  title: string,
  detail: string,
  evidence: EvidenceType = "verified"
): Finding {
  return { severity, category, page, title, detail, evidence };
}

function collectMetaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (key) map.set(key, attr(tag, "content") || "");
  }
  return map;
}

function extractCanonical(html: string): string {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if ((attr(tag, "rel") || "").toLowerCase() === "canonical")
      return attr(tag, "href") || "";
  }
  return "";
}

function extractTitle(html: string): string {
  return stripTags(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] || "");
}

function countH1(html: string): number {
  return [...html.matchAll(/<h1\b[^>]*>/gi)].length;
}

function collectImages(html: string): Array<{ hasAlt: boolean }> {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => ({
    hasAlt: hasAttr(match[0], "alt")
  }));
}

function collectAccessibleNamed(
  html: string,
  tag: "a" | "button"
): Array<{ hasAccessibleName: boolean }> {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...html.matchAll(pattern)].map((match) => {
    const [, attrs, inner] = match;
    const hasText = Boolean(stripTags(inner));
    const hasAriaLabel = Boolean(attr(attrs, "aria-label"));
    return { hasAccessibleName: hasText || hasAriaLabel };
  });
}

interface GenericFormControl {
  id: string | null;
  name: string | null;
  type: string;
  ariaLabel: string | null;
}

interface GenericForm {
  method: string | null;
  controls: GenericFormControl[];
}

function collectLabelFors(html: string): Set<string> {
  const fors = new Set<string>();
  for (const match of html.matchAll(
    /<label\b[^>]*\bfor\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi
  )) {
    const target = match[1] ?? match[2];
    if (target) fors.add(target);
  }
  return fors;
}

function collectForms(html: string): GenericForm[] {
  const forms: GenericForm[] = [];
  for (const formMatch of html.matchAll(
    /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
  )) {
    const [, formAttrs, inner] = formMatch;
    const controls: GenericFormControl[] = [];
    for (const controlMatch of inner.matchAll(
      /<(input|select|textarea)\b([^>]*)\/?>/gi
    )) {
      const [, tagName, controlAttrs] = controlMatch;
      controls.push({
        id: attr(controlAttrs, "id"),
        name: attr(controlAttrs, "name"),
        type: (attr(controlAttrs, "type") || tagName).toLowerCase(),
        ariaLabel: attr(controlAttrs, "aria-label")
      });
    }
    forms.push({ method: attr(formAttrs, "method"), controls });
  }
  return forms;
}

/**
 * Deterministic, generic (non-ReelHaus) structural findings for one already
 * safely fetched HTML page. Mirrors the non-locale-specific half of Website
 * Guardian's inspectFacts() so a customer target gets the same calibrated
 * class of verified defects Client #0's evidence relies on — without ever
 * applying reelhaus.de's own FR/AR/hreflang/RTL assumptions to someone
 * else's site.
 */
export function genericHtmlChecks(pageUrl: string, html: string): Finding[] {
  const issues: Finding[] = [];
  const meta = collectMetaMap(html);
  const title = extractTitle(html);
  const description = meta.get("description") || "";
  const viewport = meta.get("viewport") || "";
  const canonical = extractCanonical(html);
  const labelFors = collectLabelFors(html);

  if (!title) {
    issues.push(
      finding("important", "metadata", pageUrl, "Page title missing", "No <title> element was found.")
    );
  } else if (title.length < 15 || title.length > 65) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Check page title length",
        `The title is ${title.length} characters; a typical range is about 15-65.`
      )
    );
  }
  if (!description) {
    issues.push(
      finding("important", "metadata", pageUrl, "Meta description missing", "No meta description was found.")
    );
  } else if (description.length < 70 || description.length > 170) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Check meta description length",
        `The description is ${description.length} characters; a typical range is about 70-170.`
      )
    );
  }
  if (!canonical) {
    issues.push(
      finding("important", "seo", pageUrl, "Canonical URL missing", "No rel=canonical link was found.")
    );
  }
  if (!viewport.toLowerCase().includes("width=device-width")) {
    issues.push(
      finding(
        "critical",
        "responsive",
        pageUrl,
        "Mobile viewport missing",
        'No meta viewport with "width=device-width" was found.'
      )
    );
  }
  issues.push(
    finding(
      "optional",
      "responsive",
      pageUrl,
      "Manually verify visual responsive layout",
      "This collector analyzes HTML without rendering a browser viewport, so overflow, touch targets, and breakpoints are not visually verified.",
      "inference"
    )
  );

  const h1Count = countH1(html);
  if (h1Count !== 1) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Check H1 structure",
        `Found ${h1Count} <h1> heading(s); a single clear main heading is expected.`
      )
    );
  }

  const images = collectImages(html);
  const missingAlts = images.filter((image) => !image.hasAlt);
  if (missingAlts.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Images without an alt attribute",
        `${missingAlts.length} of ${images.length} image(s) have no alt attribute.`
      )
    );
  }

  const links = collectAccessibleNamed(html, "a");
  const unnamedLinks = links.filter((link) => !link.hasAccessibleName);
  if (unnamedLinks.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Links without an accessible name",
        `${unnamedLinks.length} link(s) have neither visible text nor an aria-label.`
      )
    );
  }

  const buttons = collectAccessibleNamed(html, "button");
  const unnamedButtons = buttons.filter((button) => !button.hasAccessibleName);
  if (unnamedButtons.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Buttons without an accessible name",
        `${unnamedButtons.length} button(s) have neither visible text nor an aria-label.`
      )
    );
  }

  const forms = collectForms(html);
  for (const [index, form] of forms.entries()) {
    const unlabeled = form.controls.filter(
      (control) =>
        control.type !== "hidden" &&
        !control.ariaLabel &&
        (!control.id || !labelFors.has(control.id))
    );
    const unnamed = form.controls.filter(
      (control) => control.type !== "submit" && !control.name
    );
    if (unlabeled.length) {
      issues.push(
        finding(
          "important",
          "forms",
          pageUrl,
          `Form ${index + 1} has unlabeled fields`,
          `${unlabeled.length} form control(s) have no recognizable label.`
        )
      );
    }
    if (unnamed.length) {
      issues.push(
        finding(
          "important",
          "forms",
          pageUrl,
          `Form ${index + 1} has fields without a name`,
          `${unnamed.length} form control(s) cannot be submitted normally without a name attribute.`
        )
      );
    }
    if ((form.method || "get").toLowerCase() === "get") {
      issues.push(
        finding(
          "optional",
          "forms",
          pageUrl,
          `Form ${index + 1} uses GET or no method`,
          "For personal or longer input, verify the intended HTTP method.",
          "inference"
        )
      );
    }
  }

  if (!meta.get("og:title") || !meta.get("og:description")) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Open Graph metadata incomplete",
        "og:title and/or og:description are missing."
      )
    );
  }

  return issues;
}

/**
 * Converts genericHtmlChecks() output into Task #2 EvidenceRecords tagged
 * with a distinct collector name from Website Guardian's, so the existing
 * deterministic-injection / severity-floor logic in reelscan.ts can treat
 * both collectors as equally authoritative "verified defect" sources
 * without conflating a customer target's evidence with Client #0's.
 */
export function technicalEvidenceFromGenericFindings(
  scanId: string,
  findings: Finding[],
  capturedAt: string
): Array<Omit<EvidenceRecord, "id">> {
  return findings.map((item) => ({
    scanId,
    sourceType: "html_static",
    sourceUrl: item.page,
    observationType: item.category,
    observation: `${item.title}: ${item.detail}`,
    capturedAt,
    collector: GENERIC_CHECKS_COLLECTOR,
    metadata: {
      severity: item.severity,
      verification: item.evidence
    }
  }));
}
