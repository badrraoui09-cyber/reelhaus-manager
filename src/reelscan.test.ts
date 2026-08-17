import { describe, expect, it } from "vitest";
import type { WorkersAiBinding } from "./ai-service";
import { AuditLedgerService, InMemoryAuditLedgerStore } from "./audit-ledger";
import {
  ReelScanValidationError,
  buildReelScanPrompt,
  calculateReelScanScore,
  collectClientZeroContentEvidence,
  parseReelScanAiResponse,
  recommendReelScanAction,
  runReelScanV1ClientZero,
  technicalEvidenceFromGuardianReport
} from "./reelscan";
import type { FindingRecord } from "./audit-ledger";
import type { AuditReport } from "./website-analysis";

const FR_HTML = `<!DOCTYPE html>
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
<p>Nous proposons ReelFix pour corriger votre site existant, ReelBuild pour un nouveau site, et ReelCare pour l'entretien continu. Contactez-nous pour un devis.</p>
<a href="mailto:hello@reelhaus.de">Contact</a>
</body>
</html>`;

const AR_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<title>ريل هاوس — مواقع إلكترونية للمطاعم والفنادق في المغرب</title>
<meta name="description" content="ريل هاوس يساعد المطاعم والفنادق المغربية بخدمات ReelFix وReelBuild وReelCare لتحسين حضورها الرقمي بشكل كافٍ.">
<link rel="canonical" href="https://reelhaus.de/ar/">
<link rel="alternate" hreflang="fr" href="https://reelhaus.de/fr/">
<link rel="alternate" hreflang="ar" href="https://reelhaus.de/ar/">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="ريل هاوس">
<meta property="og:description" content="مواقع إلكترونية للمطاعم والفنادق">
</head>
<body>
<h1>ريل هاوس</h1>
<p>نقدم ReelFix لإصلاح موقعكم الحالي وReelBuild لموقع جديد وReelCare للصيانة المستمرة. تواصلوا معنا لطلب عرض سعر.</p>
<a href="mailto:hello@reelhaus.de">اتصل بنا</a>
</body>
</html>`;

function fakeGuardianFetcher(): typeof fetch {
  const pages: Record<string, string> = {
    "https://reelhaus.de/fr/": FR_HTML,
    "https://reelhaus.de/ar/": AR_HTML
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method || "GET";
    if (method === "HEAD") return new Response(null, { status: 200 });
    const html = pages[url];
    if (!html) return new Response("not found", { status: 404 });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
}

function fakeAi(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

function validAiJson(evidenceIds: string[]): string {
  return JSON.stringify({
    findings: [
      {
        title: "No booking/reservation CTA above the fold",
        category: "action_path",
        severity: "important",
        priority: 2,
        summary:
          "The homepage hero area does not present a clear next action for a visitor.",
        evidenceIds: [evidenceIds[0]],
        confidence: 0.8,
        kind: "issue"
      },
      {
        title: "Clear service naming",
        category: "service_clarity",
        severity: "optional",
        priority: 4,
        summary: "ReelFix, ReelBuild and ReelCare are all named on the page.",
        evidenceIds: evidenceIds.slice(0, 2),
        confidence: 0.7,
        kind: "strength"
      }
    ]
  });
}

function fakeReport(): AuditReport {
  return {
    id: "report-fixture-1",
    createdAt: "2026-08-17T09:00:00.000Z",
    targets: ["https://reelhaus.de/fr/"],
    summary: { critical: 0, important: 0, optional: 1 },
    findings: [
      {
        severity: "optional",
        category: "responsive",
        page: "https://reelhaus.de/fr/",
        title: "Visuelles responsives Layout manuell prüfen",
        detail: "Ein Worker analysiert HTML, rendert aber keine Browser-Viewports.",
        evidence: "inference"
      }
    ],
    pages: [
      {
        url: "https://reelhaus.de/fr/",
        finalUrl: "https://reelhaus.de/fr/",
        status: 200,
        title: "ReelHaus",
        description: "desc",
        lang: "fr",
        dir: "ltr",
        canonical: "https://reelhaus.de/fr/",
        h1Count: 1,
        internalLinksChecked: 0,
        checkedAt: "2026-08-17T09:00:05.000Z"
      }
    ],
    limitations: ["read-only"]
  };
}

describe("evidence collection (no AI involved)", () => {
  it("converts Website Guardian findings into structured evidence inputs", () => {
    const report = fakeReport();
    const inputs = technicalEvidenceFromGuardianReport(report);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].scanId).toBe(report.id);
    expect(inputs[0].sourceUrl).toBe("https://reelhaus.de/fr/");
    expect(inputs[0].observation).toContain("Visuelles responsives Layout");
    expect(inputs[0].capturedAt).toBe("2026-08-17T09:00:05.000Z");
  });

  it("extracts factual content evidence without calling AI", async () => {
    const inputs = await collectClientZeroContentEvidence(
      fakeGuardianFetcher(),
      "scan-content-1"
    );
    const byType = Object.fromEntries(
      inputs.map((item) => [`${item.sourceUrl}:${item.observationType}`, item])
    );
    expect(
      byType["https://reelhaus.de/fr/:page_title"].observation
    ).toContain("ReelHaus");
    expect(
      byType["https://reelhaus.de/fr/:action_link_signals"].observation
    ).toContain("mailto:hello@reelhaus.de");
    expect(
      byType["https://reelhaus.de/fr/:service_term:ReelFix"].observation
    ).toContain("ReelFix");
    expect(
      byType["https://reelhaus.de/fr/:service_term:ReelScan"].observation
    ).toContain("not found");
    expect(inputs.every((item) => item.scanId === "scan-content-1")).toBe(
      true
    );
  });
});

describe("prompt construction", () => {
  it("gives the AI only the supplied evidence, nothing else", () => {
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const evidence = [
      ledger.recordEvidence({
        scanId: "scan-1",
        sourceType: "html_static",
        sourceUrl: "https://reelhaus.de/fr/",
        observationType: "page_title",
        observation: "Title: ReelHaus",
        capturedAt: "2026-08-17T09:00:00.000Z",
        collector: "reelscan-v1@content-evidence"
      })
    ];
    const messages = buildReelScanPrompt(evidence);
    const userMessage = messages.find((message) => message.role === "user");
    const payload = JSON.parse(
      userMessage!.content.match(/Evidence.*:\n(\[.*\])\n\n/s)![1]
    );
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe(evidence[0].id);
    expect(payload[0].observation).toBe("Title: ReelHaus");
    expect(messages[0].content).toContain(
      "Treat the supplied evidence as the complete factual universe"
    );
  });
});

describe("AI output validation", () => {
  it("accepts well-formed structured output", () => {
    const validated = parseReelScanAiResponse(
      validAiJson(["ev-1", "ev-2"]),
      new Set(["ev-1", "ev-2"])
    );
    expect(validated).toHaveLength(2);
    expect(validated[0].kind).toBe("issue");
    expect(validated[1].kind).toBe("strength");
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      parseReelScanAiResponse("not json", new Set(["ev-1"]))
    ).toThrow(ReelScanValidationError);
  });

  it("rejects a response missing the findings array", () => {
    expect(() =>
      parseReelScanAiResponse(JSON.stringify({ ok: true }), new Set(["ev-1"]))
    ).toThrow(ReelScanValidationError);
  });

  it("rejects a finding that cites an evidence ID outside the analysis run", () => {
    const json = JSON.stringify({
      findings: [
        {
          title: "x",
          category: "technical",
          severity: "optional",
          priority: 3,
          summary: "x",
          evidenceIds: ["ev-does-not-exist"],
          confidence: 0.5,
          kind: "issue"
        }
      ]
    });
    expect(() =>
      parseReelScanAiResponse(json, new Set(["ev-1"]))
    ).toThrow(ReelScanValidationError);
  });

  it("rejects a finding with no evidence IDs", () => {
    const json = JSON.stringify({
      findings: [
        {
          title: "x",
          category: "technical",
          severity: "optional",
          priority: 3,
          summary: "x",
          evidenceIds: [],
          confidence: 0.5,
          kind: "issue"
        }
      ]
    });
    expect(() => parseReelScanAiResponse(json, new Set(["ev-1"]))).toThrow(
      ReelScanValidationError
    );
  });

  it("rejects an unsupported severity or invalid priority", () => {
    const badSeverity = JSON.stringify({
      findings: [
        {
          title: "x",
          category: "technical",
          severity: "urgent",
          priority: 3,
          summary: "x",
          evidenceIds: ["ev-1"],
          kind: "issue"
        }
      ]
    });
    expect(() => parseReelScanAiResponse(badSeverity, new Set(["ev-1"]))).toThrow(
      ReelScanValidationError
    );

    const badPriority = JSON.stringify({
      findings: [
        {
          title: "x",
          category: "technical",
          severity: "optional",
          priority: 9,
          summary: "x",
          evidenceIds: ["ev-1"],
          kind: "issue"
        }
      ]
    });
    expect(() => parseReelScanAiResponse(badPriority, new Set(["ev-1"]))).toThrow(
      ReelScanValidationError
    );
  });
});

describe("runReelScanV1ClientZero orchestration", () => {
  it("completes the analysis run and persists validated findings on success", async () => {
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const ai = fakeAi(async (model, inputs) => {
      const evidence = (
        JSON.parse(
          (inputs.messages as Array<{ content: string }>)[1].content.match(
            /Evidence.*:\n(\[.*\])\n\n/s
          )![1]
        ) as Array<{ id: string }>
      ).map((item) => item.id);
      return { response: validAiJson(evidence) };
    });

    const { result } = await runReelScanV1ClientZero({
      ai,
      auditLedger: ledger,
      fetcher: fakeGuardianFetcher()
    });

    expect(result.analysisRun.status).toBe("completed");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.findings.length).toBe(2);
    expect(result.reviewStatus).toBe("needs_review");
    expect(result.score?.score).toBeLessThan(100);

    const trail = ledger.getScanAuditTrail(result.scanId);
    expect(trail.evidence.length).toBe(result.evidence.length);
    expect(trail.findings.length).toBe(2);
  });

  it("marks the analysis run failed and persists no findings when AI output is invalid", async () => {
    const ledger = new AuditLedgerService(new InMemoryAuditLedgerStore());
    const ai = fakeAi(async () => ({ response: "not valid json" }));

    const { result } = await runReelScanV1ClientZero({
      ai,
      auditLedger: ledger,
      fetcher: fakeGuardianFetcher()
    });

    expect(result.analysisRun.status).toBe("failed");
    expect(result.findings).toHaveLength(0);
    expect(result.score).toBeNull();
    expect(result.recommendation.action).toBe("no_immediate_change");

    const trail = ledger.getScanAuditTrail(result.scanId);
    expect(trail.findings).toHaveLength(0);
  });
});

describe("deterministic score", () => {
  function finding(overrides: Partial<FindingRecord>): FindingRecord {
    return {
      id: overrides.id || "finding-1",
      scanId: "scan-1",
      analysisRunId: null,
      kind: "issue",
      title: "x",
      category: "technical",
      severity: "important",
      priority: 2,
      summary: "x",
      evidenceIds: ["ev-1"],
      createdAt: "2026-08-17T09:00:00.000Z",
      scoreImpact: -10,
      ...overrides
    };
  }

  it("is reproducible for the same findings", () => {
    const findings = [
      finding({ id: "a", scoreImpact: -25 }),
      finding({ id: "b", scoreImpact: -10 }),
      finding({ id: "c", kind: "strength", scoreImpact: 0 })
    ];
    const first = calculateReelScanScore(findings);
    const second = calculateReelScanScore(findings);
    expect(first.score).toBe(second.score);
    expect(first.score).toBe(65);
    expect(first.breakdown).toHaveLength(2);
  });

  it("floors at 0 rather than going negative", () => {
    const findings = Array.from({ length: 10 }, (_, index) =>
      finding({ id: `c${index}`, scoreImpact: -25 })
    );
    expect(calculateReelScanScore(findings).score).toBe(0);
  });
});

describe("Fix-before-Build recommendation", () => {
  function finding(overrides: Partial<FindingRecord>): FindingRecord {
    return {
      id: overrides.id || "finding-1",
      scanId: "scan-1",
      analysisRunId: null,
      kind: "issue",
      title: "x",
      category: "technical",
      severity: "important",
      priority: 2,
      summary: "x",
      evidenceIds: ["ev-1"],
      createdAt: "2026-08-17T09:00:00.000Z",
      ...overrides
    };
  }

  it("recommends no change when there are no supported issues", () => {
    expect(recommendReelScanAction([]).action).toBe("no_immediate_change");
  });

  it("prefers ReelFix for repairable friction, not ReelBuild", () => {
    const findings = [
      finding({ category: "technical", severity: "critical" }),
      finding({ category: "action_path", severity: "important" })
    ];
    expect(recommendReelScanAction(findings).action).toBe("ReelFix");
  });

  it("only recommends ReelBuild for a critical, foundational problem", () => {
    const findings = [
      finding({ category: "positioning", severity: "critical" })
    ];
    expect(recommendReelScanAction(findings).action).toBe("ReelBuild");
  });

  it("does not recommend ReelBuild merely because the site is imperfect", () => {
    const findings = [
      finding({ category: "positioning", severity: "important" }),
      finding({ category: "service_clarity", severity: "optional" })
    ];
    expect(recommendReelScanAction(findings).action).not.toBe("ReelBuild");
  });

  it("recommends ReelCare for several minor issues and nothing bigger", () => {
    const findings = [
      finding({ id: "a", severity: "optional" }),
      finding({ id: "b", severity: "optional" }),
      finding({ id: "c", severity: "optional" })
    ];
    expect(recommendReelScanAction(findings).action).toBe("ReelCare");
  });
});
