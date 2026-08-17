import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHTMLRewriter } from "./fake-html-rewriter";
import {
  inspectFacts,
  parseHtml,
  summarizeFindings,
  type Finding
} from "./website-analysis";

describe("summarizeFindings", () => {
  it("groups findings by severity", () => {
    const base = {
      category: "seo",
      page: "https://reelhaus.de/fr/",
      title: "Test",
      detail: "Test",
      rootKey: "seo:test",
      evidence: "verified"
    } satisfies Omit<Finding, "severity">;

    expect(
      summarizeFindings([
        { ...base, severity: "critical" },
        { ...base, severity: "important" },
        { ...base, severity: "important" },
        { ...base, severity: "optional" }
      ])
    ).toEqual({ critical: 1, important: 2, optional: 1 });
  });

  it("returns zeroes for an empty report", () => {
    expect(summarizeFindings([])).toEqual({
      critical: 0,
      important: 0,
      optional: 0
    });
  });
});

// -- Task #5A-fix §1/§10 — Website Guardian label/accessible-name detection --
//
// Runs the REAL parseHtml()/inspectFacts() HTMLRewriter-based pipeline
// against real HTML, using a purpose-built HTMLRewriter-compatible test
// shim (fake-html-rewriter.ts) — not hand-constructed HtmlFacts fixtures,
// which would just assume the bug under test is already fixed. See
// docs comment in fake-html-rewriter.ts for why this exists.
describe("Website Guardian — form label and accessible-name detection", () => {
  beforeAll(() => {
    vi.stubGlobal("HTMLRewriter", FakeHTMLRewriter);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const PAGE_URL = "https://reelhaus.de/fr/";

  // A fully "clean" page (viewport, canonical, hreflang, og, one h1,
  // correct lang/dir) so only the injected form/link/button snippet can
  // produce a forms/accessibility finding — isolating the behavior under
  // test from every other Guardian check.
  function cleanPage(bodySnippet: string): string {
    return `<!DOCTYPE html>
<html lang="fr" dir="ltr">
<head>
<title>ReelHaus — Sites Web pour Restaurants et Hôtels au Maroc</title>
<meta name="description" content="ReelHaus aide les restaurants et hôtels marocains avec ReelFix, ReelBuild et ReelCare pour améliorer leur présence en ligne.">
<link rel="canonical" href="https://reelhaus.de/fr/">
<link rel="alternate" hreflang="fr" href="https://reelhaus.de/fr/">
<link rel="alternate" hreflang="ar" href="https://reelhaus.de/ar/">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="ReelHaus">
<meta property="og:description" content="Sites web pour l'hôtellerie-restauration">
</head>
<body>
<h1>ReelHaus</h1>
${bodySnippet}
</body>
</html>`;
  }

  async function factsFor(html: string) {
    const response = new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    return parseHtml(response);
  }

  function formFindings(findings: Finding[]) {
    return findings.filter((f) => f.category === "forms");
  }

  it("does NOT flag a control implicitly labeled by a wrapping <label>", async () => {
    const html = cleanPage(
      `<form><label>Email<input name="email"></label></form>`
    );
    const facts = await factsFor(html);
    const findings = formFindings(inspectFacts(PAGE_URL, "fr", false, facts));
    expect(findings.some((f) => f.title.includes("unbeschriftete"))).toBe(false);
  });

  it("still recognizes an explicit label[for] association", async () => {
    const html = cleanPage(
      `<form><label for="email">Email</label><input id="email" name="email"></form>`
    );
    const facts = await factsFor(html);
    const findings = formFindings(inspectFacts(PAGE_URL, "fr", false, facts));
    expect(findings.some((f) => f.title.includes("unbeschriftete"))).toBe(false);
  });

  it("recognizes aria-label as a valid association", async () => {
    const html = cleanPage(`<form><input name="email" aria-label="Email"></form>`);
    const facts = await factsFor(html);
    const findings = formFindings(inspectFacts(PAGE_URL, "fr", false, facts));
    expect(findings.some((f) => f.title.includes("unbeschriftete"))).toBe(false);
  });

  it("does not falsely call a control unlabeled merely for lacking label[for] when aria-labelledby is present", async () => {
    const html = cleanPage(
      `<form><span id="email-label">Email</span><input name="email" aria-labelledby="email-label"></form>`
    );
    const facts = await factsFor(html);
    const findings = formFindings(inspectFacts(PAGE_URL, "fr", false, facts));
    expect(findings.some((f) => f.title.includes("unbeschriftete"))).toBe(false);
  });

  it("still reports a genuinely unlabeled control as a verified defect", async () => {
    const html = cleanPage(`<form><input name="email"></form>`);
    const facts = await factsFor(html);
    const findings = formFindings(inspectFacts(PAGE_URL, "fr", false, facts));
    const unlabeled = findings.find((f) => f.title.includes("unbeschriftete"));
    expect(unlabeled).toBeTruthy();
    expect(unlabeled?.evidence).toBe("verified");
    expect(unlabeled?.severity).toBe("important");
  });

  it("does not call a linked image with a useful alt an unnamed link", async () => {
    const html = cleanPage(
      `<a href="/menu"><img src="menu-icon.png" alt="Voir le menu"></a>`
    );
    const facts = await factsFor(html);
    const findings = inspectFacts(PAGE_URL, "fr", false, facts).filter(
      (f) => f.category === "accessibility" && f.title.includes("Links")
    );
    expect(findings).toHaveLength(0);
  });

  it("still flags a link with no text, aria-label, or labeled image", async () => {
    const html = cleanPage(`<a href="/menu"><img src="menu-icon.png"></a>`);
    const facts = await factsFor(html);
    const findings = inspectFacts(PAGE_URL, "fr", false, facts).filter(
      (f) => f.category === "accessibility" && f.title.includes("Links")
    );
    expect(findings).toHaveLength(1);
  });
});
