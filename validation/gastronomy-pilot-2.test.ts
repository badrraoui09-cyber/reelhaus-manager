import { describe, expect, it } from "vitest";
import {
  EmailReviewAgent,
  EmailSalesAgent,
  QualificationAgent,
  ReelScanAuditAgent
} from "../src/business-agents";
import type {
  EmailDraft,
  GastronomyObservationKind,
  GuestJourneyStage,
  Lead,
  ObservedIssue
} from "../src/sales-types";

const observedAt = "2026-07-31T10:00:00.000Z";

interface PilotCase {
  segment: "no_standalone_website_found" | "basic_website" | "strong_website";
  lead: Lead;
  human: {
    observationAccuracy: number;
    impactRelevance: number;
    recommendationActionability: number;
    expectedOutreachQualification: boolean;
    personalizationScore?: number;
  };
}

function issue(input: {
  code: string;
  signal: string;
  journeyStage: GuestJourneyStage;
  detail: string;
  evidence: string;
  impact: string;
  suggestion: string;
  confidence: "High" | "Medium" | "Low";
  kind: GastronomyObservationKind;
  points?: number;
  sourceUrl: string;
}): ObservedIssue {
  return {
    ...input,
    observedAt,
    verified: input.kind !== "coverage_gap",
    points: input.points ?? 0
  };
}

function lead(
  id: string,
  input: Pick<
    Lead,
    | "businessName"
    | "category"
    | "city"
    | "sourceUrls"
    | "observedIssues"
  > &
    Partial<Lead>
): Lead {
  return {
    id,
    businessName: input.businessName,
    category: input.category,
    city: input.city,
    country: "MA",
    websiteUrl: input.websiteUrl,
    mapsUrl: input.mapsUrl,
    publicEmail: input.publicEmail,
    phone: input.phone,
    whatsapp: input.whatsapp,
    sourceUrls: input.sourceUrls,
    observedIssues: input.observedIssues,
    recommendedService: input.recommendedService,
    notes: input.notes || "",
    language: input.language || "fr",
    discoveredAt: observedAt,
    score: 0,
    scoreReasons: [],
    status: "new",
    lastContactedAt: null,
    nextFollowUpAt: null,
    doNotContact: false,
    createdAt: observedAt,
    updatedAt: observedAt,
    pilot: true
  };
}

function strength(
  code: string,
  signal: string,
  journeyStage: GuestJourneyStage,
  detail: string,
  sourceUrl: string
): ObservedIssue {
  return issue({
    code,
    signal,
    journeyStage,
    detail,
    evidence: detail,
    impact: "Dieser geprüfte Pfad unterstützt die Gästeentscheidung.",
    suggestion: "Aktuell halten und regelmäßig manuell prüfen.",
    confidence: "High",
    kind: "strength",
    sourceUrl
  });
}

const cases: PilotCase[] = [
  {
    segment: "no_standalone_website_found",
    lead: lead("chez-chegrouni", {
      businessName: "Chez Chegrouni",
      category: "restaurant",
      city: "Marrakech",
      phone: "+212714219367",
      sourceUrls: [
        "https://www.tripadvisor.fr/Restaurant_Review-g293734-d1097803-Reviews-Chez_Chegrouni-Marrakech_Marrakech_Safi.html",
        "https://www.restaurantsmarrakesh.com/en/listing/chez-chegrouni-marrakech"
      ],
      observedIssues: [],
      notes:
        "No standalone official website was established in the checked public listings; this is a coverage gap, not proof that no website exists."
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "no_standalone_website_found",
    lead: lead("cafe-hafa", {
      businessName: "Café Hafa",
      category: "cafe",
      city: "Tangier",
      sourceUrls: [
        "https://www.mytangier.com/place/cafe-hafa",
        "https://wanderlog.com/place/details/463400/caf%C3%A9-hafa"
      ],
      observedIssues: [],
      notes:
        "Checked sources point to a Facebook page or directory content, not a verified standalone official website."
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "no_standalone_website_found",
    lead: lead("chez-lamine", {
      businessName: "Chez Lamine",
      category: "restaurant",
      city: "Marrakech",
      phone: "+212662022080",
      sourceUrls: [
        "https://www.tripadvisor.com/Restaurant_Review-g293734-d2434157-Reviews-Chez_Lamine-Marrakech_Marrakech_Safi.html",
        "https://maps.apple.com/place?place-id=IBECF13257BEC1ECE"
      ],
      observedIssues: [],
      notes:
        "Checked public entries point to social/listing pages; no standalone official website was established."
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "basic_website",
    lead: lead("green-black", {
      businessName: "Green Black Café-Restaurant",
      category: "restaurant",
      city: "Casablanca",
      websiteUrl: "https://www.greenblack.ma/",
      sourceUrls: [
        "https://www.greenblack.ma/",
        "https://greenblack.ma/menu/"
      ],
      observedIssues: [
        issue({
          code: "hours_imprecise",
          signal: "food_service_information",
          journeyStage: "guest_decision",
          detail:
            "La page d’accueil indique « tous les jours, midi et soir » sans heures précises.",
          evidence:
            "Texte public de la page d’accueil : « tous les jours, midi et soir ».",
          impact:
            "Un client ne peut pas vérifier précisément si le restaurant est encore ouvert avant de se déplacer.",
          suggestion:
            "Afficher les heures d’ouverture exactes pour chaque jour près du menu et du contact.",
          confidence: "Medium",
          kind: "opportunity",
          points: 8,
          sourceUrl: "https://www.greenblack.ma/"
        }),
        issue({
          code: "reservation_path_not_verified",
          signal: "reservation",
          journeyStage: "guest_action",
          detail:
            "Aucun parcours de réservation n’est visible dans les pages d’accueil et de menu vérifiées.",
          evidence:
            "Navigation publique vérifiée : Accueil, À propos, Menu, Photos, Contact, Reviews.",
          impact:
            "Un visiteur prêt à réserver doit chercher un autre moyen de contact.",
          suggestion:
            "Ajouter une consigne de réservation explicite ou un bouton si ce service existe.",
          confidence: "Medium",
          kind: "opportunity",
          points: 10,
          sourceUrl: "https://www.greenblack.ma/"
        }),
        issue({
          code: "directions_path_not_verified",
          signal: "directions",
          journeyStage: "guest_action",
          detail:
            "Aucun lien d’itinéraire direct n’est visible dans les deux pages récupérées.",
          evidence:
            "Aucun lien Google Maps détecté dans l’accueil ou le menu public vérifié.",
          impact:
            "Un client mobile doit lancer une recherche séparée pour préparer son trajet.",
          suggestion:
            "Placer un lien d’itinéraire direct près de l’adresse et du contact.",
          confidence: "Medium",
          kind: "opportunity",
          points: 8,
          sourceUrl: "https://www.greenblack.ma/"
        })
      ]
    }),
    human: {
      observationAccuracy: 4.2,
      impactRelevance: 4.6,
      recommendationActionability: 4.7,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "basic_website",
    lead: lead("cafe-clock", {
      businessName: "Cafe Clock",
      category: "cafe",
      city: "Fès",
      websiteUrl: "https://www.cafeclock.com/",
      publicEmail: "info@cafeclock.com",
      phone: "+212535637855",
      sourceUrls: [
        "https://www.cafeclock.com/",
        "https://www.cafeclock.com/contact-us"
      ],
      observedIssues: [
        issue({
          code: "public_food_menu_path_missing",
          signal: "menu_accessibility",
          journeyStage: "guest_decision",
          detail:
            "La navigation publique consultée présente les ateliers, événements et galeries, mais aucun lien vers une carte de plats ou de boissons.",
          evidence:
            "Liens visibles de l’accueil vérifié : histoire, cours, événements, avis, galeries et réservations de groupe.",
          impact:
            "Un visiteur intéressé par la cuisine ne peut pas comparer les plats ou les prix avant sa visite.",
          suggestion:
            "Ajouter un lien « Menu » distinct pour chaque ville avec plats, prix et options alimentaires.",
          confidence: "Medium",
          kind: "opportunity",
          points: 10,
          sourceUrl: "https://www.cafeclock.com/"
        }),
        issue({
          code: "ordinary_table_booking_path_missing",
          signal: "reservation",
          journeyStage: "guest_action",
          detail:
            "Le site consulté propose les réservations de groupe, mais aucun parcours distinct pour réserver une table ordinaire.",
          evidence:
            "Le seul lien de réservation visible dans la navigation vérifiée est « Group Bookings ».",
          impact:
            "Une personne prête à venir à deux ou trois ne sait pas si elle doit appeler ou se présenter sans réservation.",
          suggestion:
            "Préciser clairement la règle pour les tables ordinaires à côté du téléphone de chaque ville.",
          confidence: "Medium",
          kind: "opportunity",
          points: 10,
          sourceUrl: "https://www.cafeclock.com/"
        }),
        issue({
          code: "direct_directions_link_missing",
          signal: "directions",
          journeyStage: "guest_action",
          detail:
            "La page contact donne trois adresses complètes, sans lien cartographique direct visible pour chacune.",
          evidence:
            "Adresses de Fès, Marrakech et Chefchaouen affichées comme texte sur la page contact vérifiée.",
          impact:
            "Sur mobile, un visiteur doit copier l’adresse correspondant à sa ville dans une autre application.",
          suggestion:
            "Ajouter un lien d’itinéraire distinct sous chaque adresse.",
          confidence: "Medium",
          kind: "opportunity",
          points: 8,
          sourceUrl: "https://www.cafeclock.com/contact-us"
        })
      ]
    }),
    human: {
      observationAccuracy: 4.7,
      impactRelevance: 4.8,
      recommendationActionability: 4.8,
      expectedOutreachQualification: true,
      personalizationScore: 4.5
    }
  },
  {
    segment: "basic_website",
    lead: lead("ombu", {
      businessName: "OMBÚ Restaurant & Café",
      category: "restaurant",
      city: "Essaouira",
      websiteUrl: "https://www.ombu-restaurant.com/",
      publicEmail: "info@ombu-restaurant.com",
      phone: "+212677156476",
      sourceUrls: [
        "https://www.ombu-restaurant.com/",
        "https://www.ombu-restaurant.com/menu1"
      ],
      observedIssues: [
        issue({
          code: "menu_details_not_exposed_as_text",
          signal: "menu_accessibility",
          journeyStage: "guest_decision",
          detail:
            "La page « Our Menu » vérifiée décrit la cuisine, mais n’expose pas de plats individuels ni de prix en texte lisible.",
          evidence:
            "Le texte public récupéré contient un paragraphe général sur les saveurs marocaines et internationales, sans liste de plats ou prix.",
          impact:
            "Un client ne peut pas comparer rapidement l’offre ou le budget depuis un téléphone ou une technologie d’assistance.",
          suggestion:
            "Publier les plats et prix essentiels en HTML lisible, même si une carte visuelle reste disponible.",
          confidence: "High",
          kind: "opportunity",
          points: 12,
          sourceUrl: "https://www.ombu-restaurant.com/menu1"
        }),
        issue({
          code: "opening_hours_not_verified",
          signal: "food_service_information",
          journeyStage: "guest_decision",
          detail:
            "Aucun horaire d’ouverture n’apparaît dans les pages d’accueil et de menu vérifiées.",
          evidence:
            "Les pages récupérées indiquent brunch et déjeuner, sans plages horaires ni jours d’ouverture.",
          impact:
            "Un client ne peut pas confirmer quand venir pour le brunch ou le déjeuner.",
          suggestion:
            "Afficher les jours et heures d’ouverture près du bouton de réservation.",
          confidence: "Medium",
          kind: "opportunity",
          points: 8,
          sourceUrl: "https://www.ombu-restaurant.com/"
        }),
        issue({
          code: "direct_map_link_not_verified",
          signal: "directions",
          journeyStage: "guest_action",
          detail:
            "L’adresse à l’Ensemble Artisanal est publiée, mais aucun lien de carte direct n’est visible dans les pages vérifiées.",
          evidence:
            "Adresse textuelle affichée : Rue Mohamed El Qorry, Essaouira 44000.",
          impact:
            "Un visiteur doit rechercher manuellement l’établissement avant de lancer son trajet.",
          suggestion:
            "Ajouter un lien Google Maps ou un itinéraire direct à côté de l’adresse.",
          confidence: "Medium",
          kind: "opportunity",
          points: 8,
          sourceUrl: "https://www.ombu-restaurant.com/"
        })
      ]
    }),
    human: {
      observationAccuracy: 4.8,
      impactRelevance: 4.9,
      recommendationActionability: 4.8,
      expectedOutreachQualification: true,
      personalizationScore: 4.7
    }
  },
  {
    segment: "strong_website",
    lead: lead("nomad", {
      businessName: "NOMAD",
      category: "restaurant",
      city: "Marrakech",
      websiteUrl: "https://nomadmarrakech.com/",
      publicEmail: "info@nomadmarrakech.com",
      phone: "+212524381609",
      sourceUrls: [
        "https://nomadmarrakech.com/",
        "https://nomadmarrakech.com/menu/",
        "https://nomadmarrakech.com/reservation/",
        "https://nomadmarrakech.com/contact/"
      ],
      observedIssues: [
        strength("menu_available", "menu_accessibility", "guest_decision", "Le menu public présente les plats, prix et options alimentaires.", "https://nomadmarrakech.com/menu/"),
        strength("reservation_available", "reservation", "guest_action", "Un parcours de réservation public distinct est disponible.", "https://nomadmarrakech.com/reservation/"),
        strength("directions_available", "directions", "guest_action", "La page contact fournit l’adresse et un itinéraire Google Maps.", "https://nomadmarrakech.com/contact/")
      ]
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "strong_website",
    lead: lead("cafe-bianca", {
      businessName: "Café Bianca",
      category: "cafe",
      city: "Casablanca",
      websiteUrl: "https://www.villablanca.ma/en/restaurant-cafe-bianca/",
      publicEmail: "resa@villablanca.ma",
      phone: "+212522392510",
      sourceUrls: [
        "https://www.villablanca.ma/en/restaurant-cafe-bianca/"
      ],
      observedIssues: [
        strength("menu_available", "menu_accessibility", "guest_decision", "La page donne accès à trois cartes publiques : boissons, menu et petit-déjeuner.", "https://www.villablanca.ma/en/restaurant-cafe-bianca/"),
        strength("reservation_available", "reservation", "guest_action", "Un lien « Book a table » est visible.", "https://www.villablanca.ma/en/restaurant-cafe-bianca/"),
        strength("hours_available", "food_service_information", "guest_decision", "Les horaires indiquent 7 jours sur 7, de 7 h à 22 h, en service continu.", "https://www.villablanca.ma/en/restaurant-cafe-bianca/")
      ]
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "strong_website",
    lead: lead("le-six", {
      businessName: "Le Six",
      category: "cafe",
      city: "Fès",
      websiteUrl: "https://www.lesixcafe.com/",
      publicEmail: "cafelesix@gmail.com",
      phone: "+212808533721",
      mapsUrl: "https://www.google.com/maps/place/Le+SIX/",
      sourceUrls: ["https://www.lesixcafe.com/"],
      observedIssues: [
        strength("menu_available", "menu_accessibility", "guest_decision", "La carte publique est organisée par catégories de plats.", "https://www.lesixcafe.com/"),
        strength("reservation_available", "reservation", "guest_action", "Un formulaire de réservation avec date, heure et nombre de personnes est disponible.", "https://www.lesixcafe.com/"),
        strength("directions_available", "directions", "guest_action", "La page propose des liens Google Maps et Waze.", "https://www.lesixcafe.com/")
      ]
    }),
    human: {
      observationAccuracy: 5,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  },
  {
    segment: "strong_website",
    lead: lead("bagatelle", {
      businessName: "Restaurant Bagatelle",
      category: "restaurant",
      city: "Marrakech",
      websiteUrl: "https://www.restaurant-bagatelle-marrakech.com/",
      publicEmail: "bagatellemarrakech@gmail.com",
      phone: "+212524430274",
      sourceUrls: [
        "https://www.restaurant-bagatelle-marrakech.com/"
      ],
      observedIssues: [
        strength("menu_available", "menu_accessibility", "guest_decision", "Le menu général et le menu de la semaine sont directement accessibles.", "https://www.restaurant-bagatelle-marrakech.com/"),
        strength("reservation_available", "reservation", "guest_action", "Un formulaire de réservation avec date, heure et couverts est publié.", "https://www.restaurant-bagatelle-marrakech.com/"),
        strength("hours_available", "food_service_information", "guest_decision", "L’adresse, le téléphone et des horaires détaillés sont affichés.", "https://www.restaurant-bagatelle-marrakech.com/")
      ]
    }),
    human: {
      observationAccuracy: 4.9,
      impactRelevance: 5,
      recommendationActionability: 5,
      expectedOutreachQualification: false
    }
  }
];

function draftRecord(
  leadId: string,
  subject: string,
  body: string
): EmailDraft {
  return {
    id: `draft-${leadId}`,
    leadId,
    language: "fr",
    subject,
    body,
    kind: "initial",
    status: "draft_ready",
    version: 1,
    providerDraftId: null,
    providerThreadId: null,
    createdAt: observedAt,
    updatedAt: observedAt
  };
}

describe("second real-world Gastronomy ReelScan pilot", () => {
  it("uses the required 3/3/4 real-business mix", () => {
    const counts = Object.fromEntries(
      [
        "no_standalone_website_found",
        "basic_website",
        "strong_website"
      ].map((segment) => [
        segment,
        cases.filter((entry) => entry.segment === segment).length
      ])
    );
    expect(counts).toEqual({
      no_standalone_website_found: 3,
      basic_website: 3,
      strong_website: 4
    });
    expect(cases.every((entry) => entry.lead.pilot)).toBe(true);
  });

  it("matches the human outreach-qualification benchmark and avoids false positives", () => {
    const results = cases.map((entry) => {
      const audit = ReelScanAuditAgent.analyze(entry.lead);
      const qualification = QualificationAgent.qualify(entry.lead, audit);
      return {
        name: entry.lead.businessName,
        expected: entry.human.expectedOutreachQualification,
        actual: qualification.recommendedStatus === "qualified",
        score: qualification.opportunityScore,
        confidence: qualification.evidenceConfidence
      };
    });
    expect(results.filter((result) => result.actual)).toHaveLength(2);
    expect(results.every((result) => result.actual === result.expected)).toBe(
      true
    );
    expect(
      results
        .filter((result) =>
          ["strong_website", "no_standalone_website_found"].includes(
            cases.find((entry) => entry.lead.businessName === result.name)!
              .segment
          )
        )
        .every((result) => !result.actual)
    ).toBe(true);
  });

  it("creates and approves only the two evidence-backed drafts", () => {
    const qualified = cases.filter((entry) => {
      const audit = ReelScanAuditAgent.analyze(entry.lead);
      return (
        QualificationAgent.qualify(entry.lead, audit).recommendedStatus ===
        "qualified"
      );
    });
    const reviews = qualified.map((entry) => {
      const generated = EmailSalesAgent.draft(entry.lead, "fr", "initial");
      const review = EmailReviewAgent.review(
        entry.lead,
        draftRecord(entry.lead.id, generated.subject, generated.body)
      );
      return { entry, generated, review };
    });
    expect(reviews).toHaveLength(2);
    expect(reviews.every(({ review }) => review.approved)).toBe(true);
    expect(
      reviews.every(({ entry, generated }) =>
        generated.body.includes(entry.lead.businessName)
      )
    ).toBe(true);
    expect(
      reviews.every(({ entry, generated }) =>
        generated.body.includes(
          entry.lead.observedIssues.find(
            (item) => item.signal === "menu_accessibility"
          )!.detail
        )
      )
    ).toBe(true);
  });

  it("rejects a generic message and blocks a no-evidence lead before drafting", () => {
    const cafeClock = cases.find(
      (entry) => entry.lead.id === "cafe-clock"
    )!.lead;
    const generic = draftRecord(
      cafeClock.id,
      "Votre présence en ligne",
      `Bonjour,

Nous aidons les restaurants à améliorer leur présence numérique. ReelScan est une première étape simple.

Si vous préférez ne plus recevoir de message, répondez simplement.

Badr`
    );
    const review = EmailReviewAgent.review(cafeClock, generic);
    expect(review.approved).toBe(false);
    expect(review.issues).toContain(
      "The first paragraph lacks a specific verified observation."
    );
    const noEvidence = cases.find(
      (entry) => entry.lead.id === "chez-chegrouni"
    )!.lead;
    expect(() => EmailSalesAgent.draft(noEvidence, "fr", "initial")).toThrow(
      /verified opportunities/
    );
  });

  it("prints the auditable pilot result used for the report", () => {
    const rows = cases.map((entry) => {
      const audit = ReelScanAuditAgent.analyze(entry.lead);
      const qualification = QualificationAgent.qualify(entry.lead, audit);
      let draftFirstParagraph: string | null = null;
      let reviewScore: number | null = null;
      if (qualification.recommendedStatus === "qualified") {
        const generated = EmailSalesAgent.draft(entry.lead, "fr", "initial");
        draftFirstParagraph = generated.body.split(/\n\s*\n/, 1)[0];
        reviewScore = EmailReviewAgent.review(
          entry.lead,
          draftRecord(entry.lead.id, generated.subject, generated.body)
        ).score;
      }
      return {
        business: entry.lead.businessName,
        segment: entry.segment,
        verifiedOpportunities: audit.verifiedOpportunityCount,
        opportunityScore: audit.opportunityScore,
        evidenceConfidence: audit.evidenceConfidence,
        outreachQualified:
          qualification.recommendedStatus === "qualified",
        humanObservationAccuracy: entry.human.observationAccuracy,
        humanImpactRelevance: entry.human.impactRelevance,
        humanRecommendationActionability:
          entry.human.recommendationActionability,
        humanPersonalization: entry.human.personalizationScore ?? null,
        automatedEmailReviewScore: reviewScore,
        draftFirstParagraph
      };
    });
    console.log(`PILOT_RESULT=${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(10);
  });
});
