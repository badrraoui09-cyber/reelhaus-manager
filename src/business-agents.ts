import { draftHasRequiredOptOut } from "./email-provider";
import {
  GASTRONOMY_FRAMEWORK,
  REELHAUS_PRINCIPLES,
  customerClaimIsUnsupported,
  evaluateAuditQuality,
  evaluateCommunicationQuality,
  localizedHospitalityGuidance,
  personalizeHospitalityGuidance,
  reelHausPrioritySummary,
  removeUnsupportedCustomerClaims
} from "./reelhaus-principles";
import type {
  BusinessAssistantOutput,
  EmailDraft,
  EmailReview,
  EvidenceConfidence,
  GastronomyObservation,
  GuestJourneyStage,
  Lead,
  ObservedIssue,
  OutreachLanguage,
  QualificationResult,
  RecommendedService,
  ReelScanLeadAudit
} from "./sales-types";

export const MIN_VERIFIED_OPPORTUNITIES =
  REELHAUS_PRINCIPLES.minimumVerifiedOpportunities;

function usableObservations(issues: ObservedIssue[]): ObservedIssue[] {
  return issues.filter(
    (issue) =>
      (issue.verified || issue.kind === "coverage_gap") &&
      Boolean(issue.detail.trim()) &&
      /^https?:\/\//i.test(issue.sourceUrl) &&
      !Number.isNaN(Date.parse(issue.observedAt))
  );
}

function metadataFor(
  issue: ObservedIssue
): Pick<
  GastronomyObservation,
  | "signal"
  | "journeyStage"
  | "evidence"
  | "impact"
  | "confidence"
  | "suggestion"
  | "kind"
> {
  const defaults: Record<
    string,
    {
      signal: string;
      journeyStage: GuestJourneyStage;
      impact: string;
      suggestion: string;
      confidence: EvidenceConfidence;
    }
  > = {
    website_unavailable: {
      signal: "google_visibility",
      journeyStage: "guest_discovery",
      impact: "Gäste können das Angebot über den eigenen Webauftritt nicht prüfen.",
      suggestion: "Erreichbarkeit und Weiterleitungen der öffentlichen Website prüfen.",
      confidence: "High"
    },
    contact_missing: {
      signal: "contact_availability",
      journeyStage: "guest_discovery",
      impact: "Gäste finden keinen klaren Weg für Rückfragen.",
      suggestion: "Eine gut sichtbare öffentliche Kontaktmöglichkeit ergänzen.",
      confidence: "Medium"
    },
    location_missing: {
      signal: "location_information",
      journeyStage: "guest_discovery",
      impact: "Gäste müssen den Standort separat suchen.",
      suggestion: "Adresse und einen eindeutigen Kartenlink sichtbar anbieten.",
      confidence: "Medium"
    },
    menu_missing: {
      signal: "menu_accessibility",
      journeyStage: "guest_decision",
      impact: "Gäste können Angebot und Eignung vor dem Besuch schwer einschätzen.",
      suggestion: "Eine mobil lesbare Karte mit Preisen und Kernangeboten direkt verlinken.",
      confidence: "Medium"
    },
    food_info_missing: {
      signal: "food_service_information",
      journeyStage: "guest_decision",
      impact: "Gäste erhalten zu wenig Orientierung zu Küche, Angebot oder Service.",
      suggestion: "Küche, Spezialitäten und relevante Serviceinformationen konkret nennen.",
      confidence: "Low"
    },
    hours_missing: {
      signal: "food_service_information",
      journeyStage: "guest_decision",
      impact: "Gäste können einen Besuch nicht verlässlich planen.",
      suggestion: "Aktuelle Öffnungszeiten auf der geprüften Seite sichtbar machen.",
      confidence: "Medium"
    },
    photos_missing: {
      signal: "photos",
      journeyStage: "guest_decision",
      impact: "Gäste können Atmosphäre und Angebot visuell kaum einschätzen.",
      suggestion: "Aktuelle Fotos von Speisen, Raum und Service ergänzen.",
      confidence: "Medium"
    },
    image_alt: {
      signal: "photos",
      journeyStage: "guest_decision",
      impact: "Bildinhalte bleiben für Gäste mit assistiven Technologien unverständlich.",
      suggestion: "Aussagekräftige alt-Texte für relevante Bilder ergänzen.",
      confidence: "High"
    },
    language_missing: {
      signal: "languages",
      journeyStage: "guest_decision",
      impact: "Sprache und Zielgruppe der Seite sind für Browser und Hilfstechnologien unklar.",
      suggestion: "Die Seitensprache korrekt auszeichnen und Sprachwechsel klar anbieten.",
      confidence: "High"
    },
    trust_signals_missing: {
      signal: "trust_signals",
      journeyStage: "guest_decision",
      impact: "Neue Gäste erhalten wenig überprüfbare Sicherheit für ihre Entscheidung.",
      suggestion: "Nachprüfbare Bewertungen, Presse- oder Herkunftsinformationen sichtbar verlinken.",
      confidence: "Low"
    },
    phone_missing: {
      signal: "phone",
      journeyStage: "guest_action",
      impact: "Gäste können nicht direkt telefonisch nachfragen oder reservieren.",
      suggestion: "Eine klickbare öffentliche Telefonnummer ergänzen.",
      confidence: "Medium"
    },
    whatsapp_missing: {
      signal: "whatsapp",
      journeyStage: "guest_action",
      impact: "Mobile Gäste finden keinen direkten WhatsApp-Kontakt.",
      suggestion: "Falls betrieblich betreut, einen klaren WhatsApp-Link ergänzen.",
      confidence: "Medium"
    },
    reservation_missing: {
      signal: "reservation",
      journeyStage: "guest_action",
      impact: "Reservierungsbereite Gäste müssen einen zusätzlichen Kontaktweg suchen.",
      suggestion: "Einen eindeutigen Reservierungsweg oder eine klare Reservierungsanweisung anbieten.",
      confidence: "Medium"
    },
    ordering_missing: {
      signal: "ordering",
      journeyStage: "guest_action",
      impact: "Gäste erkennen nicht, ob Abholung oder Bestellung angeboten wird.",
      suggestion: "Bestellmöglichkeiten nur dann klar verlinken, wenn der Betrieb sie tatsächlich anbietet.",
      confidence: "Low"
    },
    directions_missing: {
      signal: "directions",
      journeyStage: "guest_action",
      impact: "Gäste benötigen zusätzliche Schritte, um die Anfahrt zu planen.",
      suggestion: "Einen direkten Karten- oder Routenlink ergänzen.",
      confidence: "Medium"
    },
    mobile_viewport: {
      signal: "menu_accessibility",
      journeyStage: "guest_decision",
      impact: "Mobile Gäste können Inhalte und Aktionen schlechter nutzen.",
      suggestion: "Die Seite mit einem korrekten mobilen Viewport ausliefern.",
      confidence: "High"
    }
  };
  const known = defaults[issue.code];
  return {
    signal: issue.signal || known?.signal || issue.code,
    journeyStage:
      issue.journeyStage || known?.journeyStage || "guest_decision",
    evidence: issue.evidence || issue.detail,
    impact:
      issue.impact ||
      known?.impact ||
      "Die beobachtete Lücke kann die Gästeentscheidung erschweren.",
    confidence: issue.confidence || known?.confidence || "Low",
    suggestion:
      issue.suggestion ||
      known?.suggestion ||
      "Den Befund vor einer Änderung manuell prüfen.",
    kind: issue.kind || (issue.verified ? "opportunity" : "coverage_gap")
  };
}

function normalizeObservation(issue: ObservedIssue): GastronomyObservation {
  return { ...issue, ...metadataFor(issue) };
}

function factObservation(
  lead: Lead,
  input: {
    code: string;
    signal: string;
    journeyStage: GuestJourneyStage;
    detail: string;
    evidence: string;
    confidence: EvidenceConfidence;
    kind: GastronomyObservation["kind"];
    impact: string;
    suggestion: string;
    points?: number;
    sourceUrl?: string;
  }
): GastronomyObservation {
  return {
    ...input,
    sourceUrl: input.sourceUrl || lead.sourceUrls[0] || lead.websiteUrl || "",
    observedAt: lead.updatedAt,
    verified: input.kind !== "coverage_gap",
    points: input.points || 0
  };
}

function frameworkObservations(lead: Lead): GastronomyObservation[] {
  const observations = usableObservations(lead.observedIssues).map(
    normalizeObservation
  );
  const addIfMissing = (
    signal: string,
    create: () => GastronomyObservation
  ) => {
    if (!observations.some((item) => item.signal === signal))
      observations.push(create());
  };
  addIfMissing("google_visibility", () =>
    factObservation(lead, {
      code: lead.mapsUrl ? "google_maps_signal" : "google_visibility_unverified",
      signal: "google_visibility",
      journeyStage: "guest_discovery",
      detail: lead.mapsUrl
        ? "Ein öffentlicher Maps-Link ist gespeichert."
        : "Google-Sichtbarkeit wurde durch den Website-Scan nicht verifiziert.",
      evidence: lead.mapsUrl || "Keine unabhängige Google-Ergebnisprüfung vorhanden.",
      confidence: lead.mapsUrl ? "Medium" : "Low",
      kind: lead.mapsUrl ? "strength" : "coverage_gap",
      impact: "Google- und Maps-Signale beeinflussen, ob Gäste den Betrieb entdecken.",
      suggestion: "Google Business Profile separat und manuell prüfen."
    })
  );
  addIfMissing("contact_availability", () =>
    factObservation(lead, {
      code: lead.publicEmail || lead.phone || lead.whatsapp
        ? "contact_available"
        : "contact_missing",
      signal: "contact_availability",
      journeyStage: "guest_discovery",
      detail: lead.publicEmail || lead.phone || lead.whatsapp
        ? "Mindestens eine öffentliche Kontaktmöglichkeit ist gespeichert."
        : "Keine öffentliche Kontaktmöglichkeit ist gespeichert.",
      evidence: [lead.publicEmail, lead.phone, lead.whatsapp].filter(Boolean).join(" · "),
      confidence: "High",
      kind: lead.publicEmail || lead.phone || lead.whatsapp
        ? "strength"
        : "coverage_gap",
      impact: "Ein klarer Kontaktweg reduziert Unsicherheit vor einem Besuch.",
      suggestion: "Öffentliche Kontaktdaten sichtbar und aktuell halten.",
      points: 0
    })
  );
  addIfMissing("location_information", () =>
    factObservation(lead, {
      code: lead.mapsUrl ? "location_available" : "location_missing",
      signal: "location_information",
      journeyStage: "guest_discovery",
      detail: lead.mapsUrl
        ? "Ein öffentlicher Kartenlink ist gespeichert."
        : `Der Ort ${lead.city} ist gespeichert, aber kein Kartenlink.`,
      evidence: lead.mapsUrl || lead.city,
      confidence: lead.mapsUrl ? "High" : "Medium",
      kind: lead.mapsUrl ? "strength" : "coverage_gap",
      impact: "Eindeutige Standortinformationen erleichtern Entdeckung und Anfahrt.",
      suggestion: "Adresse und direkten Kartenlink gemeinsam anzeigen.",
      points: 0
    })
  );
  addIfMissing("phone", () =>
    factObservation(lead, {
      code: lead.phone ? "phone_available" : "phone_missing",
      signal: "phone",
      journeyStage: "guest_action",
      detail: lead.phone
        ? "Eine öffentliche Telefonnummer ist gespeichert."
        : "Keine öffentliche Telefonnummer ist gespeichert.",
      evidence: lead.phone || "Kein öffentlicher Telefonwert im Lead.",
      confidence: lead.phone ? "High" : "Low",
      kind: lead.phone ? "strength" : "coverage_gap",
      impact: "Telefonkontakt unterstützt kurzfristige Fragen und Reservierungen.",
      suggestion: "Eine klickbare Telefonnummer gut sichtbar anbieten.",
      points: 0
    })
  );
  addIfMissing("whatsapp", () =>
    factObservation(lead, {
      code: lead.whatsapp ? "whatsapp_available" : "whatsapp_missing",
      signal: "whatsapp",
      journeyStage: "guest_action",
      detail: lead.whatsapp
        ? "Ein öffentlicher WhatsApp-Kontakt ist gespeichert."
        : "Kein öffentlicher WhatsApp-Kontakt ist gespeichert.",
      evidence: lead.whatsapp || "Kein öffentlicher WhatsApp-Wert im Lead.",
      confidence: lead.whatsapp ? "High" : "Low",
      kind: lead.whatsapp ? "strength" : "coverage_gap",
      impact: "WhatsApp kann für mobile Gäste ein direkter Kontaktweg sein.",
      suggestion: "WhatsApp nur bei verlässlich betreutem Geschäftskanal anbieten.",
      points: 0
    })
  );
  addIfMissing("directions", () =>
    factObservation(lead, {
      code: lead.mapsUrl ? "directions_available" : "directions_missing",
      signal: "directions",
      journeyStage: "guest_action",
      detail: lead.mapsUrl
        ? "Ein direkter Kartenlink unterstützt die Anfahrt."
        : "Kein direkter Karten- oder Routenlink ist gespeichert.",
      evidence: lead.mapsUrl || lead.city,
      confidence: lead.mapsUrl ? "High" : "Low",
      kind: lead.mapsUrl ? "strength" : "coverage_gap",
      impact: "Ein direkter Routenlink verkürzt den Weg von der Entscheidung zum Besuch.",
      suggestion: "Einen eindeutigen Routenlink neben Adresse und Kontakt platzieren.",
      points: 0
    })
  );
  for (const [journeyStage, signals] of Object.entries(GASTRONOMY_FRAMEWORK) as Array<
    [GuestJourneyStage, Array<{ signal: string; label: string }>]
  >) {
    for (const { signal, label } of signals)
      addIfMissing(signal, () =>
        factObservation(lead, {
          code: `${signal}_not_evaluated`,
          signal,
          journeyStage,
          detail: `${label} konnte mit den vorhandenen Quellen nicht verifiziert werden.`,
          evidence: "Keine ausreichende öffentliche Evidenz gespeichert.",
          confidence: "Low",
          kind: "coverage_gap",
          impact: "Ohne Evidenz ist keine belastbare Beratungsaussage möglich.",
          suggestion: "Diesen Punkt vor Qualifizierung manuell oder mit einer geeigneten Quelle prüfen."
        })
      );
  }
  const kindRank = { opportunity: 3, strength: 2, coverage_gap: 1 };
  const confidenceRank = { High: 3, Medium: 2, Low: 1 };
  const bySignal = new Map<string, GastronomyObservation>();
  for (const observation of observations) {
    const current = bySignal.get(observation.signal);
    if (!current) {
      bySignal.set(observation.signal, observation);
      continue;
    }
    const timeDifference =
      Date.parse(observation.observedAt) - Date.parse(current.observedAt);
    if (
      timeDifference > 0 ||
      (timeDifference === 0 &&
        (kindRank[observation.kind] > kindRank[current.kind] ||
          (kindRank[observation.kind] === kindRank[current.kind] &&
            (confidenceRank[observation.confidence] >
              confidenceRank[current.confidence] ||
              observation.points > current.points))))
    )
      bySignal.set(observation.signal, observation);
  }
  return personalizeHospitalityGuidance(lead, [...bySignal.values()]);
}

function verifiedOpportunities(
  observations: GastronomyObservation[]
): GastronomyObservation[] {
  return observations.filter(
    (item) =>
      item.kind === "opportunity" &&
      item.verified &&
      item.confidence !== "Low"
  );
}

function priorityFor(
  issue: GastronomyObservation
): keyof ReelScanLeadAudit["priorities"] {
  if (issue.points >= 20) return "critical";
  if (issue.points >= 8) return "important";
  return "optional";
}

function recommendedService(
  lead: Lead,
  issues: GastronomyObservation[]
): RecommendedService {
  if (
    !lead.websiteUrl ||
    issues.some((issue) =>
      ["mobile_viewport", "website_unavailable", "contact_path_missing"].includes(
        issue.code
      )
    )
  )
    return "ReelBuild";
  if (
    issues.some((issue) =>
      [
        "menu_missing",
        "hours_missing",
        "whatsapp_missing",
        "image_alt",
        "booking_missing"
      ].includes(issue.code)
    )
  )
    return "ReelFix";
  return "ReelCare";
}

function opportunityAssessment(observations: GastronomyObservation[]) {
  const opportunities = verifiedOpportunities(observations);
  const stages = new Set(opportunities.map((item) => item.journeyStage));
  const highConfidence = opportunities.filter(
    (item) => item.confidence === "High"
  ).length;
  const minimumEvidenceMet =
    opportunities.length >= MIN_VERIFIED_OPPORTUNITIES &&
    stages.size >= REELHAUS_PRINCIPLES.minimumGuestJourneyStages;
  const evidenceConfidence: EvidenceConfidence =
    minimumEvidenceMet && highConfidence >= 2
      ? "High"
      : minimumEvidenceMet
        ? "Medium"
        : "Low";
  const opportunityStrength = Math.min(
    40,
    opportunities.reduce((sum, item) => sum + Math.max(0, item.points), 0)
  );
  const confidenceValue = Math.min(
    40,
    opportunities.reduce(
      (sum, item) => sum + (item.confidence === "High" ? 12 : 8),
      0
    )
  );
  const journeyCoverage = stages.size === 3 ? 20 : stages.size === 2 ? 14 : 7;
  return {
    opportunities,
    stages,
    highConfidence,
    minimumEvidenceMet,
    evidenceConfidence,
    opportunityStrength,
    opportunityScore: minimumEvidenceMet
      ? Math.min(100, opportunityStrength + confidenceValue + journeyCoverage)
      : null
  };
}

export class ReelScanAuditAgent {
  static analyze(lead: Lead): Omit<ReelScanLeadAudit, "id" | "createdAt"> {
    const observations = frameworkObservations(lead);
    const assessment = opportunityAssessment(observations);
    const priorities: ReelScanLeadAudit["priorities"] = {
      critical: [],
      important: [],
      optional: []
    };
    for (const issue of assessment.opportunities)
      priorities[priorityFor(issue)].push(issue);
    const framework = Object.fromEntries(
      (Object.entries(GASTRONOMY_FRAMEWORK) as Array<
        [GuestJourneyStage, Array<{ signal: string; label: string }>]
      >).map(([stage]) => [
        stage,
        {
          label: stage.replace("_", " "),
          evaluations: observations.filter(
            (observation) => observation.journeyStage === stage
          )
        }
      ])
    ) as ReelScanLeadAudit["framework"];
    return {
      leadId: lead.id,
      observations,
      framework,
      priorities,
      recommendedService: recommendedService(lead, assessment.opportunities),
      evidenceConfidence: assessment.evidenceConfidence,
      verifiedOpportunityCount: assessment.opportunities.length,
      opportunityScore: assessment.opportunityScore,
      qualityMetrics: evaluateAuditQuality(
        lead,
        observations,
        assessment.evidenceConfidence
      )
    };
  }
}

export class QualificationAgent {
  static qualify(
    lead: Lead,
    audit?: Pick<ReelScanLeadAudit, "observations">
  ): Omit<QualificationResult, "id" | "createdAt"> {
    const observations = audit?.observations || frameworkObservations(lead);
    const assessment = opportunityAssessment(
      observations.map(normalizeObservation)
    );
    const score = assessment.opportunityScore || 0;
    const reasons = [
      `${assessment.opportunities.length}/${MIN_VERIFIED_OPPORTUNITIES}: verifizierte Chancen`,
      `${assessment.stages.size}/3: abgedeckte Gastphasen`,
      `${assessment.highConfidence}: Beobachtungen mit hoher Evidenz`,
      assessment.minimumEvidenceMet
        ? `${assessment.opportunityScore}/100: evidenzbasierter Opportunity Score`
        : "Kein Opportunity Score: Mindest-Evidenz nicht erreicht"
    ];
    return {
      leadId: lead.id,
      score,
      opportunityScore: assessment.opportunityScore,
      evidenceConfidence: assessment.evidenceConfidence,
      minimumEvidenceMet: assessment.minimumEvidenceMet,
      criteria: {
        verifiedObservations: assessment.opportunities.length,
        highConfidenceObservations: assessment.highConfidence,
        journeyStagesCovered: assessment.stages.size,
        opportunityStrength: assessment.opportunityStrength
      },
      reasons,
      recommendedStatus:
        assessment.minimumEvidenceMet &&
        assessment.evidenceConfidence !== "Low" &&
        Boolean(lead.publicEmail)
          ? "qualified"
          : "new"
    };
  }
}

function localizedObservation(
  lead: Lead,
  issue: GastronomyObservation,
  language: OutreachLanguage
): string {
  const imageCount = issue.detail.match(/\d+/)?.[0] || "plusieurs";
  const httpStatus = issue.detail.match(/HTTP\s+(\d{3})/i)?.[1];
  let source = lead.businessName;
  try {
    source = new URL(issue.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    // The evidence gate already validates public source URLs. Keep a safe label.
  }
  if (language === "ar") {
    const arabic: Record<string, string> = {
      mobile_viewport: "لا تعلن الصفحة العامة عن إعداد عرض مخصص للهاتف المحمول.",
      menu_missing: "لم يظهر رابط واضح لقائمة الطعام في الصفحة العامة التي تمت مراجعتها.",
      hours_missing: "لم تظهر ساعات العمل في الصفحة العامة التي تمت مراجعتها.",
      whatsapp_missing: "لم يظهر رابط واتساب عام في الصفحة التي تمت مراجعتها.",
      image_alt: `توجد ${imageCount} صور معروضة بدون وصف بديل alt.`,
      website_unavailable: httpStatus
        ? `أعاد الموقع العام رمز HTTP ${httpStatus}.`
        : "لم يكن الموقع العام متاحاً أثناء المراجعة."
    };
    const observation = arabic[issue.code] || issue.detail;
    return `على المصدر العام ${source}، ${observation}`;
  }
  const french: Record<string, string> = {
    mobile_viewport:
      "la page publique ne déclare pas de viewport adapté aux appareils mobiles.",
    menu_missing:
      "aucun lien clair vers le menu ou la carte n’a été détecté sur la page publique examinée.",
    hours_missing:
      "les horaires d’ouverture n’ont pas été détectés sur la page publique examinée.",
    whatsapp_missing:
      "aucun lien WhatsApp public n’a été détecté sur la page examinée.",
    image_alt: `${imageCount} images livrées par la page ne comportent pas d’attribut alt.`,
    website_unavailable: httpStatus
      ? `le site public a répondu avec le code HTTP ${httpStatus}.`
      : "le site public n’était pas disponible pendant la vérification."
  };
  const observation = french[issue.code] || issue.detail;
  return `sur la source publique ${source}, ${observation}`;
}

function localizedImpact(
  lead: Lead,
  issue: GastronomyObservation,
  language: OutreachLanguage
): string {
  return localizedHospitalityGuidance(lead, issue, language).impact;
}

function localizedSuggestion(
  lead: Lead,
  issue: GastronomyObservation,
  language: OutreachLanguage
): string {
  return localizedHospitalityGuidance(lead, issue, language).suggestion;
}

function opportunityFor(lead: Lead): GastronomyObservation {
  const observations = frameworkObservations(lead);
  const assessment = opportunityAssessment(observations);
  if (!assessment.minimumEvidenceMet)
    throw new Error(
      `At least ${MIN_VERIFIED_OPPORTUNITIES} verified opportunities across two guest stages are required before drafting`
    );
  return [...assessment.opportunities].sort((a, b) => {
    const confidence = { High: 3, Medium: 2, Low: 1 };
    return (
      confidence[b.confidence] - confidence[a.confidence] ||
      b.points - a.points
    );
  })[0];
}

export class EmailSalesAgent {
  static draft(
    lead: Lead,
    language: OutreachLanguage,
    kind: EmailDraft["kind"]
  ): { subject: string; body: string } {
    const issue = opportunityFor(lead);
    const observation = localizedObservation(lead, issue, language);
    const impact = localizedImpact(lead, issue, language);
    const suggestion = localizedSuggestion(lead, issue, language);
    if (language === "ar") {
      const opening =
        kind === "initial"
          ? arabicInitialOpening(lead, issue, observation, impact, suggestion)
          : `أتابع ملاحظتي السابقة حول ${lead.businessName} في ${lead.city}: ${observation} الأثر على الضيف هو أن ${impact}، والخطوة الواقعية المقترحة هي ${suggestion}.`;
      const output = {
        subject: `ملاحظة عملية حول حضور ${lead.businessName} على الإنترنت`,
        body: `${opening}

أنا بدر، مؤسس ReelHaus. يمكنني البدء بـ ReelScan قصير لتأكيد هذه النقطة وترتيب ما يستحق الإصلاح أولاً، من دون التزام بتنفيذ تغييرات.

إذا كان ذلك مناسباً، يسعدني إرسال التفاصيل. وإذا كنتم تفضلون عدم تلقي أي رسائل أخرى، يكفي الرد بذلك وسنوقف التواصل نهائياً.

مع التحية،
Badr
ReelHaus`
      };
      return {
        subject: removeUnsupportedCustomerClaims(output.subject),
        body: removeUnsupportedCustomerClaims(output.body)
      };
    }
    const opening =
      kind === "initial"
        ? frenchInitialOpening(lead, issue, observation, impact, suggestion)
        : `Je reviens sur le point vérifié pour ${lead.businessName} à ${lead.city} : ${observation} L’impact pour vos futurs visiteurs reste le suivant : ${impact}; l’action directement liée : ${suggestion}.`;
    const output = {
      subject: `Une observation concrète pour ${lead.businessName}`,
      body: `${opening}

Je suis Badr, fondateur de ReelHaus. Je peux commencer par un ReelScan court pour confirmer ce point et hiérarchiser uniquement les corrections utiles, sans engagement de mise en œuvre.

Si cela vous semble utile, je peux vous transmettre les détails. Si vous préférez ne plus recevoir de message, répondez simplement en ce sens et nous arrêterons définitivement tout contact.

Bien cordialement,
Badr
ReelHaus`
    };
    return {
      subject: removeUnsupportedCustomerClaims(output.subject),
      body: removeUnsupportedCustomerClaims(output.body)
    };
  }
}

function openingVariant(lead: Lead, issue: GastronomyObservation): number {
  const value = `${lead.businessName}|${lead.city}|${lead.category}|${issue.signal}`;
  return [...value].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 3;
}

function frenchInitialOpening(
  lead: Lead,
  issue: GastronomyObservation,
  observation: string,
  impact: string,
  suggestion: string
): string {
  const variants = [
    `En examinant le parcours public de ${lead.businessName} à ${lead.city}, j’ai vérifié un point précis : ${observation} Pour ce type d’établissement, cela compte car ${impact}. Une action directement liée à ce constat : ${suggestion}.`,
    `J’ai suivi le parcours en ligne d’un futur visiteur de ${lead.businessName} à ${lead.city}. Le constat vérifié est le suivant : ${observation} Pour vos visiteurs, ${impact}. La correction la plus directement liée serait : ${suggestion}.`,
    `En préparant une visite chez ${lead.businessName} à ${lead.city}, un élément public et vérifiable ressort : ${observation} Son effet possible dans le parcours du visiteur est précis : ${impact}. Je recommande cette action : ${suggestion}.`
  ];
  return variants[openingVariant(lead, issue)];
}

function arabicInitialOpening(
  lead: Lead,
  issue: GastronomyObservation,
  observation: string,
  impact: string,
  suggestion: string
): string {
  const variants = [
    `أثناء مراجعة المسار العام لـ ${lead.businessName} في ${lead.city}، تحققت من ملاحظة محددة: ${observation} أهميتها للضيف هي أن ${impact}. اقتراح عملي مباشر هو ${suggestion}.`,
    `اتبعت مسار ضيف محتمل يبحث عن ${lead.businessName} في ${lead.city}. الملاحظة المتحققة هي: ${observation} بالنسبة للضيف، ${impact}. والخطوة الأكثر ارتباطاً بها هي ${suggestion}.`,
    `عند التحضير لزيارة ${lead.businessName} في ${lead.city}، ظهر عنصر عام قابل للتحقق: ${observation} أثره المحتمل في رحلة الضيف هو ${impact}. لذلك أقترح ${suggestion}.`
  ];
  return variants[openingVariant(lead, issue)];
}

export interface PeerDraftOpening {
  businessName: string;
  city: string;
  firstParagraph: string;
}

function normalizedOpeningTokens(
  firstParagraph: string,
  businessName: string,
  city: string
): Set<string> {
  let normalized = firstParagraph.toLocaleLowerCase();
  for (const value of [businessName, city])
    normalized = normalized.replaceAll(value.toLocaleLowerCase(), " business ");
  return new Set(
    normalized
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\u0600-\u06ff.-]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

export function draftOpeningSimilarity(
  current: PeerDraftOpening,
  peer: PeerDraftOpening
): number {
  const left = normalizedOpeningTokens(
    current.firstParagraph,
    current.businessName,
    current.city
  );
  const right = normalizedOpeningTokens(
    peer.firstParagraph,
    peer.businessName,
    peer.city
  );
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

export function removeFakePromises(value: string): string {
  return removeUnsupportedCustomerClaims(value);
}

export class EmailReviewAgent {
  static review(
    lead: Lead,
    draft: Pick<EmailDraft, "id" | "version" | "language" | "subject" | "body">,
    peerDrafts: PeerDraftOpening[] = []
  ): Omit<EmailReview, "id" | "createdAt"> {
    const issues: string[] = [];
    let rewrittenSubject = removeFakePromises(draft.subject);
    let rewrittenBody = removeFakePromises(draft.body);
    let verifiedObservation: GastronomyObservation | undefined;
    try {
      verifiedObservation = opportunityFor(lead);
    } catch {
      issues.push("Minimum verified gastronomy evidence is not met.");
    }
    const observation = verifiedObservation
      ? localizedObservation(lead, verifiedObservation, draft.language)
      : undefined;
    const impact = verifiedObservation
      ? localizedImpact(lead, verifiedObservation, draft.language)
      : undefined;
    const suggestion = verifiedObservation
      ? localizedSuggestion(lead, verifiedObservation, draft.language)
      : undefined;
    const firstParagraph = rewrittenBody.split(/\n\s*\n/, 1)[0].trim();
    const communicationQuality = evaluateCommunicationQuality({
      businessName: lead.businessName,
      city: lead.city,
      firstParagraph,
      expectedObservation: observation,
      expectedImpact: impact,
      expectedSuggestion: suggestion
    });
    if (!communicationQuality.evidenceBased)
      issues.push("The first paragraph lacks a specific verified observation.");
    if (!impact || !firstParagraph.includes(impact))
      issues.push("The first paragraph does not explain why the issue matters to guests.");
    if (!suggestion || !firstParagraph.includes(suggestion))
      issues.push("The first paragraph lacks one realistic restaurant-specific suggestion.");
    if (!communicationQuality.businessSpecific)
      issues.push(
        "The first paragraph is not unique to this restaurant and could be reused unchanged."
      );
    if (!communicationQuality.ownerUnderstandable)
      issues.push("The message is not concise and understandable for a hospitality owner.");
    if (communicationQuality.genericLanguagePresent)
      issues.push("Generic agency language must be replaced with business-specific reasoning.");
    const highestPeerSimilarity = peerDrafts.reduce(
      (highest, peer) =>
        Math.max(
          highest,
          draftOpeningSimilarity(
            {
              businessName: lead.businessName,
              city: lead.city,
              firstParagraph
            },
            peer
          )
        ),
      0
    );
    if (highestPeerSimilarity >= 0.92)
      issues.push(
        "The opening is too similar to another lead draft and must use this business's own evidence."
      );
    if (customerClaimIsUnsupported(`${draft.subject}\n${draft.body}`))
      issues.push("Unverifiable promise or commercial guarantee removed.");
    if (!draftHasRequiredOptOut({ body: rewrittenBody }))
      issues.push("A polite opt-out is required.");
    if (!rewrittenBody.includes("ReelScan"))
      issues.push("ReelScan is not presented as the low-risk first step.");
    if (draft.language === "ar" && !/[\u0600-\u06ff]/.test(rewrittenBody))
      issues.push("Arabic draft does not contain natural Arabic text.");
    if (draft.language === "fr" && !/\b(Je|Nous|vous|votre)\b/.test(rewrittenBody))
      issues.push("French draft does not contain a natural French sentence.");
    if (rewrittenBody.length > 1_600) issues.push("Message is too long.");
    if (issues.length && verifiedObservation) {
      const safe = EmailSalesAgent.draft(lead, draft.language, "initial");
      rewrittenSubject = safe.subject;
      rewrittenBody = safe.body;
    }
    const score = Math.max(0, 100 - issues.length * 20);
    return {
      draftId: draft.id,
      draftVersion: draft.version,
      score,
      approved: score >= 80 && issues.length === 0,
      personalization: communicationQuality.personalization,
      issues,
      rewrittenSubject,
      rewrittenBody
    };
  }
}

export class FollowUpAgent {
  static direction(language: OutreachLanguage): "ltr" | "rtl" {
    return language === "ar" ? "rtl" : "ltr";
  }
}

export class BusinessAssistantAgent {
  static prepare(
    lead: Lead,
    type: BusinessAssistantOutput["type"]
  ): BusinessAssistantOutput {
    const observations = frameworkObservations(lead).filter(
      (observation) => observation.verified
    );
    const observationText = observations.length
      ? observations.map((issue) => `• ${issue.detail} (${issue.sourceUrl})`).join("\n")
      : "No verified issue has been stored.";
    const contactText = [
      lead.publicEmail ? `Email: ${lead.publicEmail}` : "",
      lead.phone ? `Phone: ${lead.phone}` : "",
      lead.whatsapp ? `WhatsApp: ${lead.whatsapp}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    return {
      type,
      title: `${lead.businessName} — ${type.replaceAll("_", " ")}`,
      sections: [
        {
          heading: "Verified business facts",
          content: `${lead.category} · ${lead.city}, Morocco\n${lead.websiteUrl || "No website stored"}`
        },
        { heading: "Verified observations", content: observationText },
        {
          heading: "Public contact",
          content: contactText || "No public contact has been stored."
        },
        {
          heading: "ReelHaus priorities",
          content: reelHausPrioritySummary()
        },
        {
          heading: "Suggested next internal action",
          content:
            type === "proposal_outline"
              ? `Prepare a scoped ${lead.recommendedService || "ReelScan"} proposal for human review.`
              : "Review the facts and choose the next action manually."
        }
      ],
      factsOnly: true,
      externalActionTaken: false
    };
  }
}
