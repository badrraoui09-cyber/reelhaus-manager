import { describe, expect, it } from "vitest";
import {
  GASTRONOMY_FRAMEWORK,
  REELHAUS_AI_VERSION,
  REELHAUS_PRINCIPLES,
  evaluateCommunicationQuality,
  removeUnsupportedCustomerClaims
} from "./reelhaus-principles";

describe("ReelHaus Master Intelligence Layer", () => {
  it("defines the hospitality identity and guest journey centrally", () => {
    expect(REELHAUS_AI_VERSION).toBe("1.0");
    expect(REELHAUS_PRINCIPLES.version).toBe(REELHAUS_AI_VERSION);
    expect(REELHAUS_PRINCIPLES.identity.primaryCategories).toEqual([
      "restaurant",
      "cafe",
      "bakery",
      "snack",
      "riad",
      "small_hotel"
    ]);
    expect(Object.keys(GASTRONOMY_FRAMEWORK)).toEqual([
      "guest_discovery",
      "guest_decision",
      "guest_action"
    ]);
    expect(REELHAUS_PRINCIPLES.preOutputQuestions).toHaveLength(4);
  });

  it("removes the unsupported reservation claim", () => {
    const cleaned = removeUnsupportedCustomerClaims(
      `Bonjour,
We increase reservations
Nous avons identifié une amélioration possible dans le parcours de contact.`
    );
    expect(cleaned).not.toContain("We increase reservations");
    expect(cleaned).toContain("amélioration possible");
  });

  it("rates generic communication as non-specific", () => {
    const quality = evaluateCommunicationQuality({
      businessName: "Café Atlas",
      city: "Marrakech",
      firstParagraph:
        "Nous aidons les restaurants à améliorer votre présence numérique."
    });
    expect(quality.evidenceBased).toBe(false);
    expect(quality.businessSpecific).toBe(false);
    expect(quality.genericLanguagePresent).toBe(true);
    expect(quality.personalization).toBeLessThan(3);
  });

  it("rates evidence, impact and a concrete suggestion separately", () => {
    const observation =
      "la carte publique ne présente aucun prix pour les plats du déjeuner.";
    const impact =
      "les visiteurs ne peuvent pas estimer leur budget avant de venir";
    const suggestion =
      "ajouter les prix à côté des plats déjà publiés sur la carte mobile";
    const quality = evaluateCommunicationQuality({
      businessName: "Café Atlas",
      city: "Marrakech",
      firstParagraph: `Pour Café Atlas à Marrakech, nous avons vérifié que ${observation} Ainsi, ${impact}. Une mesure réaliste serait d’${suggestion}.`,
      expectedObservation: observation,
      expectedImpact: impact,
      expectedSuggestion: suggestion
    });
    expect(quality.evidenceBased).toBe(true);
    expect(quality.usefulToOwner).toBe(true);
    expect(quality.businessSpecific).toBe(true);
    expect(quality.ownerUnderstandable).toBe(true);
    expect(quality.personalization).toBe(5);
  });
});
