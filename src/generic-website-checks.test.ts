import { describe, expect, it } from "vitest";
import {
  GENERIC_CHECKS_COLLECTOR,
  genericHtmlChecks,
  technicalEvidenceFromGenericFindings
} from "./generic-website-checks";

const CLEAN_HTML = `<!DOCTYPE html><html lang="fr"><head>
  <title>Le Petit Café — Restaurant à Casablanca</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Un restaurant familial servant une cuisine marocaine authentique au centre de Casablanca.">
  <link rel="canonical" href="https://lepetitcafe.example/">
  <meta property="og:title" content="Le Petit Café">
  <meta property="og:description" content="Restaurant à Casablanca">
  </head><body>
  <h1>Le Petit Café</h1>
  <img src="hero.jpg" alt="Salle du restaurant">
  <a href="/menu">Voir le menu</a>
</body></html>`;

describe("genericHtmlChecks", () => {
  it("finds nothing on a fully clean page beyond the always-on inference note", () => {
    const findings = genericHtmlChecks("https://lepetitcafe.example/", CLEAN_HTML);
    expect(findings.filter((f) => f.evidence === "verified")).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toBe("inference");
    expect(findings[0].severity).toBe("optional");
  });

  it("flags a missing mobile viewport as critical and verified", () => {
    const html = CLEAN_HTML.replace(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      ""
    );
    const findings = genericHtmlChecks("https://lepetitcafe.example/", html);
    const viewport = findings.find((f) => f.title === "Mobile viewport missing");
    expect(viewport?.severity).toBe("critical");
    expect(viewport?.evidence).toBe("verified");
  });

  it("flags a missing canonical link", () => {
    const html = CLEAN_HTML.replace(
      '<link rel="canonical" href="https://lepetitcafe.example/">',
      ""
    );
    const findings = genericHtmlChecks("https://lepetitcafe.example/", html);
    expect(findings.some((f) => f.title === "Canonical URL missing")).toBe(true);
  });

  it("flags images missing an alt attribute, but not images with an empty alt", () => {
    const html = `<html><head><title>x-page-title-long-enough</title><meta name="viewport" content="width=device-width"><meta name="description" content="a description that is long enough to pass the seventy character minimum length check easily"><link rel="canonical" href="https://x.example/"></head><body><h1>x</h1><img src="a.jpg"><img src="b.jpg" alt=""></body></html>`;
    const findings = genericHtmlChecks("https://x.example/", html);
    const alt = findings.find((f) => f.title === "Images without an alt attribute");
    expect(alt?.detail).toContain("1 of 2");
  });

  it("flags links and buttons with no accessible name", () => {
    const html = `<html><head><title>x-page-title-long-enough</title><meta name="viewport" content="width=device-width"><meta name="description" content="a description that is long enough to pass the seventy character minimum length check easily"><link rel="canonical" href="https://x.example/"></head><body><h1>x</h1><a href="/foo"></a><button></button></body></html>`;
    const findings = genericHtmlChecks("https://x.example/", html);
    expect(findings.some((f) => f.title === "Links without an accessible name")).toBe(true);
    expect(findings.some((f) => f.title === "Buttons without an accessible name")).toBe(true);
  });

  it("flags unlabeled and unnamed form controls independently", () => {
    const html = `<html><head><title>x-page-title-long-enough</title><meta name="viewport" content="width=device-width"><meta name="description" content="a description that is long enough to pass the seventy character minimum length check easily"><link rel="canonical" href="https://x.example/"></head><body><h1>x</h1>
      <form><input name="email"><input id="unlabeled-but-named" name="phone"><button>Send</button></form>
    </body></html>`;
    const findings = genericHtmlChecks("https://x.example/", html);
    const unlabeled = findings.find((f) => f.title === "Form 1 has unlabeled fields");
    expect(unlabeled?.detail).toContain("2 form control(s)");
  });

  it("does not flag a form control with a matching label[for]", () => {
    const html = `<html><head><title>x-page-title-long-enough</title><meta name="viewport" content="width=device-width"><meta name="description" content="a description that is long enough to pass the seventy character minimum length check easily"><link rel="canonical" href="https://x.example/"></head><body><h1>x</h1>
      <form><label for="email-field">Email</label><input id="email-field" name="email"><button>Send</button></form>
    </body></html>`;
    const findings = genericHtmlChecks("https://x.example/", html);
    expect(findings.some((f) => f.category === "forms" && f.title.includes("unlabeled"))).toBe(
      false
    );
  });

  it("never emits a FR/AR, hreflang, or RTL finding — those are ReelHaus-only", () => {
    const html = `<html lang="en"><head><title>x-page-title-long-enough</title></head><body><h1>x</h1></body></html>`;
    const findings = genericHtmlChecks("https://x.example/", html);
    expect(
      findings.some((f) => /hreflang|rtl|sprache|arabisch/i.test(`${f.title} ${f.detail}`))
    ).toBe(false);
  });
});

describe("technicalEvidenceFromGenericFindings", () => {
  it("tags every record with the generic-checks collector and severity/verification metadata", () => {
    const findings = genericHtmlChecks("https://lepetitcafe.example/", "<html></html>");
    const evidence = technicalEvidenceFromGenericFindings(
      "scan-1",
      findings,
      "2026-08-17T10:00:00.000Z"
    );
    expect(evidence.length).toBe(findings.length);
    for (const [index, item] of evidence.entries()) {
      expect(item.collector).toBe(GENERIC_CHECKS_COLLECTOR);
      expect(item.metadata?.severity).toBe(findings[index].severity);
      expect(item.metadata?.verification).toBe(findings[index].evidence);
    }
  });
});
