import { describe, expect, it } from "vitest";
import {
  BusinessAssistantAgent,
  EmailReviewAgent,
  EmailSalesAgent,
  FollowUpAgent,
  QualificationAgent,
  ReelScanAuditAgent,
  removeFakePromises
} from "./business-agents";
import { evaluateHospitalityGuidance } from "./reelhaus-principles";
import type { EmailDraft, Lead } from "./sales-types";

const observedAt = "2026-07-30T08:00:00.000Z";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    businessName: "Café Atlas",
    category: "cafe",
    city: "Marrakech",
    country: "MA",
    websiteUrl: "https://example.com/",
    mapsUrl: "https://maps.google.com/?q=atlas",
    publicEmail: "contact@example.com",
    phone: "+212500000000",
    whatsapp: undefined,
    sourceUrls: ["https://example.com/"],
    observedIssues: [
      {
        code: "menu_missing",
        detail: "Aucun lien de menu n’est visible sur la page publique.",
        sourceUrl: "https://example.com/",
        observedAt,
        verified: true,
        points: 10
      },
      {
        code: "image_alt",
        detail: "8 Bilder haben kein alt-Attribut.",
        sourceUrl: "https://example.com/",
        observedAt,
        verified: true,
        points: 10
      },
      {
        code: "reservation_missing",
        detail: "Kein eindeutiger Reservierungsweg ist sichtbar.",
        sourceUrl: "https://example.com/",
        observedAt,
        verified: true,
        points: 10
      }
    ],
    recommendedService: "ReelFix",
    notes: "",
    language: "fr",
    discoveredAt: observedAt,
    score: 0,
    scoreReasons: [],
    status: "new",
    lastContactedAt: null,
    nextFollowUpAt: null,
    doNotContact: false,
    createdAt: observedAt,
    updatedAt: observedAt,
    pilot: false,
    ...overrides
  };
}

describe("modular business agents", () => {
  it("keeps ReelScan facts sourced and excludes unverified claims", () => {
    const result = ReelScanAuditAgent.analyze(
      lead({
        observedIssues: [
          ...lead().observedIssues,
          {
            code: "invented",
            detail: "Unverified claim",
            sourceUrl: "https://example.com/",
            observedAt,
            verified: false,
            points: 25
          }
        ]
      })
    );
    expect(
      result.observations.some((observation) => observation.code === "invented")
    ).toBe(false);
    expect(result.framework.guest_discovery.evaluations.length).toBeGreaterThan(
      0
    );
    expect(result.framework.guest_decision.evaluations.length).toBeGreaterThan(
      0
    );
    expect(result.framework.guest_action.evaluations.length).toBeGreaterThan(0);
    expect(
      Object.values(result.framework).flatMap((stage) => stage.evaluations)
    ).toHaveLength(13);
    expect(result.recommendedService).toBe("ReelFix");
    expect(result.qualityMetrics.observationQuality).toBeGreaterThan(0);
    expect(result.qualityMetrics.businessRelevance).toBeGreaterThan(0);
    expect(result.qualityMetrics.confidence).toBe(
      result.evidenceConfidence
    );
  });

  it("produces the same evidence-gated opportunity score for the same facts", () => {
    const first = QualificationAgent.qualify(lead());
    const second = QualificationAgent.qualify(lead());
    expect(first).toEqual(second);
    expect(first.minimumEvidenceMet).toBe(true);
    expect(first.opportunityScore).toBeGreaterThan(0);
    expect(first.evidenceConfidence).not.toBe("Low");
    expect(first.recommendedStatus).toBe("qualified");
  });

  it("creates natural French copy from a verified observation", () => {
    const draft = EmailSalesAgent.draft(lead(), "fr", "initial");
    expect(draft.body).toContain(
      "8 images livrées par la page ne comportent pas d’attribut alt"
    );
    expect(draft.body).not.toContain("Kein Menü");
    expect(draft.body).toContain("ReelScan");
    expect(draft.body).toContain("ne plus recevoir");
    expect(draft.body).toContain("Marrakech");
    expect(draft.body).toMatch(/Pour une personne|Pour vos futurs visiteurs/);
    expect(draft.body).toContain("compare un café à Marrakech");
    expect(draft.body).toContain("pour Café Atlas");
  });

  it("creates Arabic copy with RTL direction and an opt-out", () => {
    const draft = EmailSalesAgent.draft(lead({ language: "ar" }), "ar", "initial");
    expect(FollowUpAgent.direction("ar")).toBe("rtl");
    expect(draft.body).toMatch(/[\u0600-\u06ff]/);
    expect(draft.body).toContain("عدم تلقي");
  });

  it("removes fake promises and refuses review approval", () => {
    const safe = EmailSalesAgent.draft(lead(), "fr", "initial");
    const unsafe: EmailDraft = {
      id: "draft-1",
      leadId: "lead-1",
      language: "fr",
      subject: "Résultats garantis à 100 %",
      body: `${safe.body}\nAugmentation du chiffre d’affaires garantie.`,
      kind: "initial",
      status: "draft_ready",
      version: 1,
      providerDraftId: null,
      providerThreadId: null,
      createdAt: observedAt,
      updatedAt: observedAt
    };
    const review = EmailReviewAgent.review(lead(), unsafe);
    expect(review.approved).toBe(false);
    expect(review.issues).toContain(
      "Unverifiable promise or commercial guarantee removed."
    );
    expect(removeFakePromises(unsafe.body)).not.toMatch(
      /chiffre d['’]affaires/i
    );
  });

  it('removes the unsupported claim "We increase reservations"', () => {
    expect(
      removeFakePromises(
        "Observation vérifiée.\nWe increase reservations\nSuggestion réaliste."
      )
    ).toBe("Observation vérifiée.\nSuggestion réaliste.");
  });

  it("rejects a generic email that could be sent to another restaurant unchanged", () => {
    const generic: EmailDraft = {
      id: "draft-generic",
      leadId: "lead-1",
      language: "fr",
      subject: "Votre présence en ligne",
      body: `Bonjour,

Nous aidons les restaurants à améliorer leur présence numérique. ReelScan est une première étape simple.

Si vous préférez ne plus recevoir de message, répondez simplement.

Badr`,
      kind: "initial",
      status: "draft_ready",
      version: 1,
      providerDraftId: null,
      providerThreadId: null,
      createdAt: observedAt,
      updatedAt: observedAt
    };
    const review = EmailReviewAgent.review(lead(), generic);
    expect(review.approved).toBe(false);
    expect(review.issues).toContain(
      "The first paragraph is not unique to this restaurant and could be reused unchanged."
    );
    expect(review.rewrittenBody).toContain("Café Atlas");
  });

  it("approves a specific restaurant email with evidence, guest impact and a suggestion", () => {
    const text = EmailSalesAgent.draft(lead(), "fr", "initial");
    const specific: EmailDraft = {
      id: "draft-specific",
      leadId: "lead-1",
      language: "fr",
      subject: text.subject,
      body: text.body,
      kind: "initial",
      status: "draft_ready",
      version: 1,
      providerDraftId: null,
      providerThreadId: null,
      createdAt: observedAt,
      updatedAt: observedAt
    };
    const review = EmailReviewAgent.review(lead(), specific);
    expect(review.approved).toBe(true);
    expect(review.issues).toEqual([]);
    expect(review.personalization).toBe(5);
  });

  it("uses each business source and context instead of repeating one lead result", () => {
    const atlas = EmailSalesAgent.draft(lead(), "fr", "initial");
    const rabatLead = lead({
      id: "lead-2",
      businessName: "Dar Rabat",
      category: "restaurant",
      city: "Rabat",
      websiteUrl: "https://dar-rabat.example/",
      sourceUrls: ["https://dar-rabat.example/"],
      observedIssues: lead().observedIssues.map((issue) => ({
        ...issue,
        sourceUrl: "https://dar-rabat.example/"
      }))
    });
    const rabat = EmailSalesAgent.draft(rabatLead, "fr", "initial");
    expect(atlas.body).toContain("example.com");
    expect(rabat.body).toContain("dar-rabat.example");
    expect(rabat.body).toContain("Dar Rabat");
    expect(rabat.body).not.toBe(atlas.body);
  });

  it("rejects a copied opening already used for another lead", () => {
    const text = EmailSalesAgent.draft(lead(), "fr", "initial");
    const firstParagraph = text.body.split(/\n\s*\n/, 1)[0];
    const draft: EmailDraft = {
      id: "draft-copy-check",
      leadId: "lead-1",
      language: "fr",
      subject: text.subject,
      body: text.body,
      kind: "initial",
      status: "draft_ready",
      version: 1,
      providerDraftId: null,
      providerThreadId: null,
      createdAt: observedAt,
      updatedAt: observedAt
    };
    const review = EmailReviewAgent.review(lead(), draft, [
      {
        businessName: "Autre Café",
        city: "Rabat",
        firstParagraph: firstParagraph
          .replaceAll("Café Atlas", "Autre Café")
          .replaceAll("Marrakech", "Rabat")
      }
    ]);
    expect(review.approved).toBe(false);
    expect(review.issues).toContain(
      "The opening is too similar to another lead draft and must use this business's own evidence."
    );
  });

  it("does not qualify and does not score a lead without minimum evidence", () => {
    const result = QualificationAgent.qualify(
      lead({
        observedIssues: [],
        mapsUrl: undefined,
        phone: undefined,
        whatsapp: undefined
      })
    );
    expect(result.minimumEvidenceMet).toBe(false);
    expect(result.opportunityScore).toBeNull();
    expect(result.evidenceConfidence).toBe("Low");
    expect(result.recommendedStatus).toBe("new");
  });

  it("creates different impact and recommendation for the same observation in two restaurant contexts", () => {
    const marrakechRestaurant = ReelScanAuditAgent.analyze(
      lead({
        businessName: "Dar Atlas",
        category: "restaurant",
        city: "Marrakech"
      })
    );
    const fesCafe = ReelScanAuditAgent.analyze(
      lead({
        businessName: "Café Medina",
        category: "cafe",
        city: "Fès"
      })
    );
    const first = marrakechRestaurant.observations.find(
      (item) => item.signal === "menu_accessibility"
    )!;
    const second = fesCafe.observations.find(
      (item) => item.signal === "menu_accessibility"
    )!;
    expect(first.detail).toBe(second.detail);
    expect(first.impact).not.toBe(second.impact);
    expect(first.suggestion).not.toBe(second.suggestion);
    expect(first.impact).toContain("Marrakech");
    expect(second.impact).toContain("Fès");
    expect(first.suggestion).toContain("Dar Atlas");
    expect(second.suggestion).toContain("Café Medina");
  });

  it("rejects and rewrites a generic recommendation before accepting the audit", () => {
    const audit = ReelScanAuditAgent.analyze(
      lead({
        observedIssues: lead().observedIssues.map((item) =>
          item.code === "menu_missing"
            ? { ...item, suggestion: "Improve your online presence." }
            : item
        )
      })
    );
    const menu = audit.observations.find(
      (item) => item.signal === "menu_accessibility"
    )!;
    expect(
      evaluateHospitalityGuidance(lead(), {
        ...menu,
        suggestion: "Improve your online presence."
      }).accepted
    ).toBe(false);
    expect(menu.suggestion).not.toMatch(/improve your online presence/i);
    expect(evaluateHospitalityGuidance(lead(), menu).accepted).toBe(true);
  });

  it("creates no recommendation when evidence is missing", () => {
    const audit = ReelScanAuditAgent.analyze(
      lead({
        observedIssues: [],
        mapsUrl: undefined,
        publicEmail: undefined,
        phone: undefined,
        whatsapp: undefined
      })
    );
    const gaps = audit.observations.filter(
      (item) => item.kind === "coverage_gap"
    );
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((item) => item.suggestion === "")).toBe(true);
    expect(audit.opportunityScore).toBeNull();
  });

  it("creates internal assistant output without external action", () => {
    const output = BusinessAssistantAgent.prepare(lead(), "client_brief");
    expect(output.factsOnly).toBe(true);
    expect(output.externalActionTaken).toBe(false);
    expect(JSON.stringify(output)).toContain("https://example.com/");
  });
});
