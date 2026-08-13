import type {
  EvidenceConfidence,
  GastronomyObservation,
  GuestJourneyStage,
  Lead,
  LeadCategory,
  OutreachLanguage,
  ReelHausQualityMetrics
} from "./sales-types";

export const REELHAUS_AI_VERSION = "1.0" as const;

export const REELHAUS_PRINCIPLES = {
  version: REELHAUS_AI_VERSION,
  identity: {
    name: "ReelHaus",
    role: "Digital visibility partner",
    market: "Morocco",
    primaryCategories: [
      "restaurant",
      "cafe",
      "bakery",
      "snack",
      "riad",
      "small_hotel"
    ] satisfies LeadCategory[],
    secondaryRule:
      "Selected local businesses are in scope only when the same evidence-backed digital visibility problems apply."
  },
  philosophy: [
    {
      name: "Quality over quantity",
      rule: "Ten relevant businesses are better than one hundred random leads."
    },
    {
      name: "Evidence before recommendation",
      rule: "Every recommendation requires an observation, guest impact and confidence level."
    },
    {
      name: "Think from the guest perspective",
      rule: "Evaluate discovery, decision and action before proposing work."
    },
    {
      name: "Understand hospitality",
      rule: "A hospitality business is more than a website."
    }
  ],
  preOutputQuestions: [
    "Is this based on evidence?",
    "Is this useful for the business owner?",
    "Is this specific to this business?",
    "Would a restaurant owner understand the value?"
  ],
  writing: {
    requiredTone: ["human", "respectful", "concise", "professional"],
    avoid: [
      "agency clichés",
      "generic phrases",
      "aggressive sales language",
      "fake urgency"
    ],
    preferredExample:
      "We identified possible improvements in how customers find information and contact your business online."
  },
  minimumVerifiedOpportunities: 3,
  minimumGuestJourneyStages: 2
} as const;

export const GASTRONOMY_FRAMEWORK: Record<
  GuestJourneyStage,
  Array<{ signal: string; label: string }>
> = {
  guest_discovery: [
    { signal: "google_visibility", label: "Google visibility signals" },
    { signal: "contact_availability", label: "Contact availability" },
    { signal: "location_information", label: "Location information" }
  ],
  guest_decision: [
    { signal: "menu_accessibility", label: "Menu accessibility" },
    {
      signal: "food_service_information",
      label: "Food and service information"
    },
    { signal: "photos", label: "Photos and atmosphere" },
    { signal: "languages", label: "Languages" },
    { signal: "trust_signals", label: "Trust signals" }
  ],
  guest_action: [
    { signal: "phone", label: "Phone" },
    { signal: "whatsapp", label: "WhatsApp" },
    { signal: "reservation", label: "Reservation" },
    { signal: "ordering", label: "Ordering" },
    { signal: "directions", label: "Directions" }
  ]
};

export const DISALLOWED_CUSTOMER_CLAIMS = [
  /\bgaranti(?:e|r|s)?\b/i,
  /\b100\s*%\b/i,
  /\bclassement garanti\b/i,
  /\bchiffre d['’]affaires\b/i,
  /\brevenus? garantis?\b/i,
  /\bwe (?:will |can )?increase (?:your )?(?:sales|revenue|reservations|bookings|customers)\b/i,
  /\bwe (?:will |can )?get (?:you )?more customers\b/i,
  /\bnous (?:allons |pouvons )?augment(?:er|ons) (?:vos |les )?(?:ventes|revenus|réservations|clients)\b/i,
  /\bplus de clients? garanti/i,
  /نتائج مضمونة/i,
  /ترتيب مضمون/i,
  /زيادة (?:المبيعات|الحجوزات|العملاء)/i
];

export const GENERIC_CUSTOMER_PHRASES = [
  /\bimprove your online presence\b/i,
  /\btransform your digital presence\b/i,
  /\bgrow your business\b/i,
  /\baméliorer votre présence numérique\b/i,
  /\bfaire passer votre activité au niveau supérieur\b/i,
  /تحسين حضوركم الرقمي/i
];

export function customerClaimIsUnsupported(value: string): boolean {
  return DISALLOWED_CUSTOMER_CLAIMS.some((pattern) => pattern.test(value));
}

export function removeUnsupportedCustomerClaims(value: string): string {
  return value
    .split(/\r?\n/)
    .filter(
      (line) =>
        !DISALLOWED_CUSTOMER_CLAIMS.some((pattern) => pattern.test(line))
    )
    .join("\n")
    .trim();
}

export function isReelHausPrimaryCategory(category: LeadCategory): boolean {
  return (
    REELHAUS_PRINCIPLES.identity.primaryCategories as readonly LeadCategory[]
  ).includes(category);
}

const GERMAN_BUSINESS_CONTEXT: Record<LeadCategory, string> = {
  restaurant: "ein Restaurant",
  cafe: "ein Café",
  bakery: "eine Bäckerei",
  snack: "einen Snack-Betrieb",
  beach_club: "einen Beach Club",
  rooftop_restaurant: "ein Rooftop-Restaurant",
  riad: "einen Riad",
  small_hotel: "ein kleines Hotel",
  local_business: "einen lokalen Betrieb"
};

const FRENCH_BUSINESS_CONTEXT: Record<LeadCategory, string> = {
  restaurant: "un restaurant",
  cafe: "un café",
  bakery: "une boulangerie",
  snack: "un snack",
  beach_club: "un beach club",
  rooftop_restaurant: "un restaurant rooftop",
  riad: "un riad",
  small_hotel: "un petit hôtel",
  local_business: "un établissement local"
};

const ARABIC_BUSINESS_CONTEXT: Record<LeadCategory, string> = {
  restaurant: "مطعماً",
  cafe: "مقهى",
  bakery: "مخبزة",
  snack: "مطعماً خفيفاً",
  beach_club: "نادياً شاطئياً",
  rooftop_restaurant: "مطعماً على السطح",
  riad: "رياضاً",
  small_hotel: "فندقاً صغيراً",
  local_business: "نشاطاً محلياً"
};

const RECOMMENDATION_TERMS: Record<string, RegExp> = {
  google_visibility: /Google|Such|sichtbar|fiche|بحث|ظهور/i,
  contact_availability: /Kontakt|E-Mail|Telefon|contact|اتصال/i,
  location_information: /Adresse|Karte|Standort|adresse|carte|عنوان|خريطة/i,
  menu_accessibility:
    /Menü|Karte|Gericht|Preis|menu|carte|plat|prix|قائمة|سعر/i,
  food_service_information:
    /Öffnungs|Küche|Angebot|horaires|cuisine|service|ساعات|مطبخ|خدمة/i,
  photos: /Foto|Bild|alt|photo|image|صورة/i,
  languages: /Sprache|Sprachwechsel|langue|لغة/i,
  trust_signals: /Bewertung|Presse|Herkunft|avis|presse|تقييم|ثقة/i,
  phone: /Telefon|Nummer|téléphone|هاتف/i,
  whatsapp: /WhatsApp/i,
  reservation: /Reserv|Buchung|réserv|حجز/i,
  ordering: /Bestell|Abholung|command|retrait|طلب|استلام/i,
  directions: /Route|Karte|Anfahrt|itinéraire|carte|اتجاه|خريطة/i
};

function existingStrengthContext(
  lead: Lead,
  observations: GastronomyObservation[],
  signal: string,
  language: "de" | OutreachLanguage
): string {
  const hasLanguageStrength = observations.some(
    (item) => item.signal === "languages" && item.kind === "strength"
  );
  if (signal === "reservation" && lead.phone)
    return language === "fr"
      ? " Conserver le numéro public vérifié comme solution alternative."
      : language === "ar"
        ? " مع إبقاء رقم الهاتف العام المتحقق منه كخيار بديل."
        : " Den bereits bestätigten öffentlichen Telefonkontakt als Alternative beibehalten.";
  if (
    ["contact_availability", "phone", "whatsapp"].includes(signal) &&
    lead.publicEmail
  )
    return language === "fr"
      ? " Conserver l’adresse e-mail publique déjà vérifiée comme autre point de contact."
      : language === "ar"
        ? " مع إبقاء البريد المهني العام المتحقق منه كوسيلة اتصال بديلة."
        : " Die bereits bestätigte öffentliche Geschäfts-E-Mail als zweiten Kontaktweg beibehalten.";
  if (hasLanguageStrength)
    return language === "fr"
      ? " Reprendre ce parcours dans la langue déjà vérifiée sur le site."
      : language === "ar"
        ? " وتقديم المسار نفسه باللغة التي تم التحقق منها على الموقع."
        : " Den neuen Pfad in der bereits verifizierten Seitensprache konsistent anbieten.";
  return "";
}

function germanImpact(lead: Lead, observation: GastronomyObservation): string {
  const guest = `Gäste, die ${GERMAN_BUSINESS_CONTEXT[lead.category]} in ${lead.city} vergleichen`;
  const impacts: Record<string, string> = {
    google_visibility: `${guest}, beginnen häufig mit Google- und Karteninformationen; die beobachtete Sichtbarkeitslücke kann verhindern, dass sie ${lead.businessName} im Rechercheweg eindeutig prüfen.`,
    contact_availability: `${guest}, suchen vor einer Entscheidung nach einem schnellen Kontaktweg; die beobachtete Kontaktlücke kann Rückfragen verzögern oder den Wechsel zu einem leichter erreichbaren Betrieb begünstigen.`,
    location_information: `${guest}, prüfen Standort und Entfernung vor dem Besuch; die beobachtete Standortlücke kann zusätzliche Suche verursachen und die Anfahrtsplanung unterbrechen.`,
    menu_accessibility: `${guest}, öffnen meist Karte und Preise, bevor sie einen Ort auswählen; die beobachtete Menühürde kann sie zwingen, anderswo weiterzusuchen, bevor sie das Angebot von ${lead.businessName} einschätzen können.`,
    food_service_information: `${guest}, benötigen konkrete Angaben zu Öffnungszeiten, Küche und Service; die beobachtete Informationslücke kann dazu führen, dass sie Eignung oder Besuchszeit nicht sicher beurteilen.`,
    photos: `${guest}, nutzen Fotos, um Speisen und Atmosphäre einzuschätzen; die beobachtete Bildlücke kann die Entscheidung erschweren und Inhalte für assistive Technologien unverständlich lassen.`,
    languages: `${guest}, müssen Angebot und Handlungswege in einer klar erkennbaren Sprache verstehen; die beobachtete Sprachlücke kann Missverständnisse vor Kontakt oder Reservierung verursachen.`,
    trust_signals: `${guest}, achten bei einem unbekannten Betrieb auf überprüfbare Vertrauenssignale; die beobachtete Lücke kann Unsicherheit bis zur Entscheidung bestehen lassen.`,
    phone: `${guest}, nutzen bei kurzfristigen Fragen oder Reservierungen häufig einen antippbaren Telefonkontakt; die beobachtete Telefonhürde kann diesen direkten Handlungsschritt abbrechen.`,
    whatsapp: `${guest}, erwarten auf dem Smartphone einen eindeutig betreuten WhatsApp-Weg, wenn er angeboten wird; die beobachtete Lücke kann einen bevorzugten mobilen Kontaktweg offenlassen.`,
    reservation: `${guest}, möchten nach der Auswahl ohne Umweg reservieren; der beobachtete Reservierungsbruch kann zusätzliche Suche erzeugen und die konkrete Besuchsabsicht unterbrechen.`,
    ordering: `${guest}, müssen vor einer Bestellung erkennen, ob Lieferung, Abholung oder Vorbestellung existiert; die beobachtete Unklarheit kann dazu führen, dass sie den verfügbaren Service nicht nutzen.`,
    directions: `${guest}, wechseln nach ihrer Entscheidung direkt zur Navigation; der beobachtete fehlende Routenpfad kann eine zusätzliche Suche erzwingen und die Anfahrt zu ${lead.businessName} erschweren.`
  };
  return (
    impacts[observation.signal] ||
    `${guest}, benötigen einen klaren Weg von der Information zur Handlung; der beobachtete Befund kann diesen Weg mit einem zusätzlichen Schritt unterbrechen.`
  );
}

function germanRecommendation(
  lead: Lead,
  observation: GastronomyObservation,
  observations: GastronomyObservation[]
): string {
  const recommendations: Record<string, string> = {
    google_visibility: `Für ${lead.businessName} die öffentlichen Google- und Kartenangaben manuell prüfen und bestätigte Adresse, Kategorie sowie Kontaktwege konsistent halten.`,
    contact_availability: `Für ${lead.businessName} einen klar beschrifteten öffentlichen Kontaktweg direkt bei den wichtigsten Besuchsinformationen platzieren.`,
    location_information: `Bei ${lead.businessName} die vollständige veröffentlichte Adresse mit einem direkten Kartenlink verbinden.`,
    menu_accessibility: `Für ${lead.businessName} einen direkten, mobil lesbaren Menüpfad mit den veröffentlichten Hauptangeboten und Preisen an einer frühen Entscheidungsstelle platzieren.`,
    food_service_information: `Für ${lead.businessName} die bestätigten Öffnungszeiten, Küchenart und relevanten Servicehinweise gemeinsam und leicht scanbar veröffentlichen.`,
    photos: `Für ${lead.businessName} aktuelle Bilder von Speisen und Atmosphäre sinnvoll strukturieren und relevante Bilder mit konkreten alt-Texten versehen.`,
    languages: `Bei ${lead.businessName} die veröffentlichte Seitensprache korrekt auszeichnen und vorhandene Sprachwechsel an denselben Stellen anbieten.`,
    trust_signals: `Für ${lead.businessName} ausschließlich überprüfbare Bewertungen, Pressehinweise oder Herkunftsinformationen nahe der Entscheidungspunkte verlinken.`,
    phone: `Bei ${lead.businessName} die bestätigte öffentliche Telefonnummer als antippbaren Link bei Kontakt und Reservierung anzeigen.`,
    whatsapp: `Für ${lead.businessName} nur dann einen klar beschrifteten WhatsApp-Link ergänzen, wenn dieser öffentliche Geschäftskanal tatsächlich betreut wird.`,
    reservation: `Für ${lead.businessName} einen eindeutigen Reservierungsbutton oder eine konkrete Reservierungsanweisung ohne zusätzlichen Suchschritt anbieten.`,
    ordering: `Bei ${lead.businessName} Lieferung, Abholung oder Vorbestellung nur für tatsächlich angebotene Services klar benennen und direkt verlinken.`,
    directions: `Für ${lead.businessName} einen direkten Routenlink unmittelbar neben der veröffentlichten Adresse platzieren.`
  };
  return (
    (recommendations[observation.signal] ||
      `Für ${lead.businessName} den in der Beobachtung beschriebenen Informationspfad gezielt korrigieren und danach auf einem Mobilgerät erneut prüfen.`) +
    existingStrengthContext(lead, observations, observation.signal, "de")
  );
}

export function evaluateHospitalityGuidance(
  lead: Lead,
  observation: GastronomyObservation
): {
  accepted: boolean;
  impactSpecific: boolean;
  recommendationSpecific: boolean;
  recommendationSolvesObservation: boolean;
} {
  if (observation.kind === "coverage_gap")
    return {
      accepted: observation.suggestion.trim() === "",
      impactSpecific: false,
      recommendationSpecific: false,
      recommendationSolvesObservation: false
    };
  if (observation.kind !== "opportunity")
    return {
      accepted: true,
      impactSpecific: true,
      recommendationSpecific: true,
      recommendationSolvesObservation: true
    };
  const impactSpecific =
    observation.impact.includes(lead.city) &&
    /Gäste|Besucher|guest|client|ضيف/i.test(observation.impact) &&
    /kann|können|führt|zwingt|unterbricht|verhindert/i.test(observation.impact);
  const recommendationSpecific =
    observation.suggestion.includes(lead.businessName) &&
    !/improve (?:your )?online presence|améliorer votre présence numérique|Online-Präsenz verbessern/i.test(
      observation.suggestion
    );
  const recommendationSolvesObservation =
    RECOMMENDATION_TERMS[observation.signal]?.test(observation.suggestion) ??
    false;
  return {
    accepted:
      impactSpecific &&
      recommendationSpecific &&
      recommendationSolvesObservation,
    impactSpecific,
    recommendationSpecific,
    recommendationSolvesObservation
  };
}

export function personalizeHospitalityGuidance(
  lead: Lead,
  observations: GastronomyObservation[]
): GastronomyObservation[] {
  return observations.map((observation) => {
    if (observation.kind === "coverage_gap")
      return { ...observation, suggestion: "" };
    if (observation.kind !== "opportunity") return observation;
    const rewritten = {
      ...observation,
      impact: germanImpact(lead, observation),
      suggestion: germanRecommendation(lead, observation, observations)
    };
    if (evaluateHospitalityGuidance(lead, rewritten).accepted) return rewritten;
    return {
      ...rewritten,
      impact: `Gäste, die ${GERMAN_BUSINESS_CONTEXT[lead.category]} in ${lead.city} vergleichen, können durch den beobachteten Befund einen zusätzlichen Schritt zwischen Information und Handlung benötigen.`,
      suggestion: `Für ${lead.businessName} den konkret beobachteten Informationspfad korrigieren und die Lösung anschließend aus Gästesicht auf einem Mobilgerät prüfen.`
    };
  });
}

export function localizedHospitalityGuidance(
  lead: Lead,
  observation: GastronomyObservation,
  language: OutreachLanguage
): { impact: string; suggestion: string } {
  const category =
    language === "ar"
      ? ARABIC_BUSINESS_CONTEXT[lead.category]
      : FRENCH_BUSINESS_CONTEXT[lead.category];
  if (language === "ar") {
    const guest = `بالنسبة إلى ضيف يقارن ${category} في ${lead.city}`;
    const impacts: Record<string, string> = {
      menu_accessibility: `${guest}، تظهر قائمة الطعام والأسعار عادة قبل اختيار المكان؛ وقد تدفعه صعوبة الوصول التي تمت ملاحظتها إلى متابعة البحث قبل فهم عرض ${lead.businessName}`,
      food_service_information: `${guest}، تساعد ساعات العمل ونوع المطبخ ومعلومات الخدمة على التخطيط للزيارة؛ وقد يمنعه النقص الملحوظ من معرفة الوقت أو العرض المناسب`,
      reservation: `${guest}، يأتي الحجز مباشرة بعد اختيار المكان؛ وقد تقطع صعوبة مسار الحجز الملحوظة نية الزيارة الجاهزة`,
      directions: `${guest}، ينتقل عادة من القرار إلى تطبيق الملاحة؛ وقد يفرض غياب رابط اتجاهات مباشر بحثاً إضافياً قبل الوصول إلى ${lead.businessName}`,
      contact_availability: `${guest}، يبحث عن وسيلة سريعة لطرح سؤال قبل القرار؛ وقد يؤخر غياب مسار اتصال واضح هذه الخطوة`,
      location_information: `${guest}، يحتاج إلى تأكيد الموقع والمسافة قبل الزيارة؛ وقد تضيف فجوة الموقع الملحوظة بحثاً منفصلاً`,
      phone: `${guest}، يستخدم الهاتف للأسئلة أو الحجوزات القريبة؛ وقد توقف صعوبة الاتصال الملحوظة هذه الخطوة المباشرة`,
      whatsapp: `${guest} عبر الهاتف المحمول، قد يكون واتساب وسيلة الاتصال المفضلة؛ وقد تترك الفجوة الملحوظة هذا المسار غير واضح`,
      photos: `${guest}، تساعد صور الأطباق والأجواء على اتخاذ القرار؛ وقد تقلل فجوة الصور الملحوظة من وضوح التجربة المتوقعة`,
      languages: `${guest}، يجب أن يفهم العرض ومسار الإجراء بلغة واضحة؛ وقد تسبب فجوة اللغة الملحوظة ارتباكاً قبل الاتصال`,
      trust_signals: `${guest} لأول مرة، تدعم الإشارات القابلة للتحقق الثقة؛ وقد تترك الفجوة الملحوظة تردداً عند الاختيار`,
      ordering: `${guest}، يجب أن يعرف ما إذا كان الطلب أو الاستلام متاحاً؛ وقد تمنعه الحالة غير الواضحة من استخدام خدمة موجودة`,
      google_visibility: `${guest}، يبدأ غالباً من Google أو الخرائط؛ وقد تمنعه فجوة الظهور الملحوظة من التحقق من ${lead.businessName}`
    };
    const suggestions: Record<string, string> = {
      menu_accessibility: `إضافة رابط قائمة مباشر وسهل القراءة على الهاتف لـ ${lead.businessName} يعرض الأطباق والأسعار المنشورة`,
      food_service_information: `جمع ساعات العمل ونوع المطبخ ومعلومات الخدمة المؤكدة لـ ${lead.businessName} في قسم واحد واضح`,
      reservation: `إضافة زر حجز واضح أو تعليمات حجز مباشرة لـ ${lead.businessName} دون خطوة بحث إضافية`,
      directions: `وضع رابط اتجاهات مباشر لـ ${lead.businessName} بجانب العنوان المنشور`,
      contact_availability: `وضع وسيلة اتصال عامة ومحددة لـ ${lead.businessName} بجانب معلومات الزيارة الأساسية`,
      location_information: `ربط عنوان ${lead.businessName} المنشور بخريطة مباشرة`,
      phone: `عرض رقم الهاتف العام المؤكد لـ ${lead.businessName} كرابط قابل للنقر`,
      whatsapp: `إضافة رابط واتساب واضح لـ ${lead.businessName} فقط إذا كانت القناة المهنية متابعة فعلاً`,
      photos: `تنظيم صور حديثة للأطباق والأجواء لدى ${lead.businessName} وإضافة أوصاف بديلة دقيقة`,
      languages: `تحديد لغة صفحات ${lead.businessName} بوضوح وتقديم مسار التحويل اللغوي في المواضع نفسها`,
      trust_signals: `ربط تقييمات أو معلومات منشأ قابلة للتحقق فقط قرب نقاط القرار لدى ${lead.businessName}`,
      ordering: `تسمية وربط الطلب أو الاستلام لدى ${lead.businessName} فقط للخدمات الموجودة فعلاً`,
      google_visibility: `مراجعة بيانات Google والخرائط العامة لـ ${lead.businessName} وتوحيد العنوان والفئة ووسائل الاتصال المؤكدة`
    };
    return {
      impact:
        impacts[observation.signal] ||
        `${guest}، قد تضيف المشكلة الملحوظة خطوة غير ضرورية بين البحث والإجراء`,
      suggestion:
        (suggestions[observation.signal] ||
          `حل مسار المعلومات المحدد الذي تمت ملاحظته لدى ${lead.businessName} ثم اختباره من هاتف محمول`) +
        existingStrengthContext(lead, [observation], observation.signal, "ar")
    };
  }
  const guest = `Pour une personne qui compare ${category} à ${lead.city}`;
  const impacts: Record<string, string> = {
    menu_accessibility: `${guest}, la carte et les prix interviennent généralement avant le choix du lieu ; la difficulté observée peut l’obliger à poursuivre sa recherche avant de comprendre l’offre de ${lead.businessName}`,
    food_service_information: `${guest}, les horaires, la cuisine et les informations de service permettent de planifier la visite ; la lacune observée peut empêcher de confirmer le bon moment ou l’adéquation de l’offre`,
    reservation: `${guest}, la réservation suit directement le choix du lieu ; la rupture observée peut interrompre une intention de visite déjà concrète`,
    directions: `${guest}, le passage de la décision à l’itinéraire est immédiat ; l’absence observée d’un lien direct peut imposer une recherche supplémentaire avant de rejoindre ${lead.businessName}`,
    contact_availability: `${guest}, un contact rapide sert à lever une question avant la décision ; la lacune observée peut retarder cette étape ou favoriser un établissement plus facile à joindre`,
    location_information: `${guest}, le lieu et la distance sont vérifiés avant le déplacement ; la lacune observée peut interrompre la préparation de la visite`,
    phone: `${guest}, le téléphone sert souvent aux questions urgentes et aux réservations proches ; la friction observée peut bloquer cette action directe`,
    whatsapp: `${guest} sur mobile, WhatsApp peut être le canal préféré ; la lacune observée peut laisser ce parcours de contact sans réponse claire`,
    photos: `${guest}, les photos des plats et de l’ambiance réduisent l’incertitude ; la lacune observée peut rendre l’expérience plus difficile à évaluer`,
    languages: `${guest}, l’offre et les actions doivent être comprises dans une langue clairement identifiée ; la lacune observée peut créer un doute avant le contact`,
    trust_signals: `${guest} pour la première fois, des signaux vérifiables soutiennent la confiance ; la lacune observée peut maintenir une hésitation au moment du choix`,
    ordering: `${guest}, il faut comprendre si la commande, le retrait ou la livraison existe ; l’incertitude observée peut empêcher l’usage d’un service disponible`,
    google_visibility: `${guest}, le parcours commence souvent sur Google ou Maps ; la lacune observée peut empêcher de vérifier clairement ${lead.businessName}`
  };
  const suggestions: Record<string, string> = {
    menu_accessibility: `pour ${lead.businessName}, placer un lien direct vers une carte lisible sur mobile avec les plats et prix publiés`,
    food_service_information: `regrouper pour ${lead.businessName} les horaires confirmés, le type de cuisine et les informations de service dans un bloc facile à parcourir`,
    reservation: `pour ${lead.businessName}, proposer un bouton de réservation ou une consigne précise sans étape de recherche supplémentaire`,
    directions: `placer pour ${lead.businessName} un lien d’itinéraire direct juste à côté de l’adresse publiée`,
    contact_availability: `placer pour ${lead.businessName} un moyen de contact public clairement nommé près des informations essentielles`,
    location_information: `relier l’adresse publiée de ${lead.businessName} à une carte directe`,
    phone: `afficher le numéro public vérifié de ${lead.businessName} comme lien cliquable aux points de contact`,
    whatsapp: `ajouter pour ${lead.businessName} un lien WhatsApp clairement nommé uniquement si ce canal professionnel est réellement suivi`,
    photos: `pour ${lead.businessName}, structurer des photos récentes des plats et de l’ambiance avec des descriptions alt précises`,
    languages: `déclarer correctement la langue des pages de ${lead.businessName} et placer les changements de langue aux mêmes étapes`,
    trust_signals: `pour ${lead.businessName}, relier uniquement des avis, mentions presse ou informations de provenance vérifiables près des points de décision`,
    ordering: `pour ${lead.businessName}, nommer et relier la commande, le retrait ou la livraison uniquement pour les services réellement disponibles`,
    google_visibility: `vérifier manuellement les informations Google et Maps de ${lead.businessName}, puis aligner adresse, catégorie et contacts confirmés`
  };
  return {
    impact:
      impacts[observation.signal] ||
      `${guest}, le problème observé peut ajouter une étape inutile entre la recherche et l’action`,
    suggestion:
      (suggestions[observation.signal] ||
        `corriger pour ${lead.businessName} le parcours d’information précisément observé, puis le tester sur mobile`) +
      existingStrengthContext(lead, [observation], observation.signal, "fr")
  };
}

function boundedRating(value: number): number {
  return Number(Math.max(0, Math.min(5, value)).toFixed(1));
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function sourceBelongsToLead(lead: Lead, sourceUrl: string): boolean {
  try {
    const source = new URL(sourceUrl);
    const allowed = [lead.websiteUrl, ...lead.sourceUrls]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value).hostname.replace(/^www\./, ""));
    return allowed.includes(source.hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

export function evaluateAuditQuality(
  lead: Lead,
  observations: GastronomyObservation[],
  confidence: EvidenceConfidence
): ReelHausQualityMetrics {
  const verified = observations.filter(
    (observation) => observation.verified && observation.kind !== "coverage_gap"
  );
  const opportunities = verified.filter(
    (observation) => observation.kind === "opportunity"
  );
  const validSignals = new Set(
    Object.values(GASTRONOMY_FRAMEWORK)
      .flat()
      .map(({ signal }) => signal)
  );
  const observationQuality = boundedRating(
    average(
      verified.map((observation) => {
        const checks = [
          /^https?:\/\//i.test(observation.sourceUrl),
          !Number.isNaN(Date.parse(observation.observedAt)),
          observation.evidence.trim().length >= 10,
          observation.impact.trim().length >= 20,
          observation.confidence !== "Low"
        ];
        return checks.filter(Boolean).length;
      })
    )
  );
  const businessRelevance = boundedRating(
    average(
      verified.map((observation) => {
        const checks = [
          validSignals.has(observation.signal),
          Boolean(observation.journeyStage),
          observation.impact.trim().length >= 20,
          observation.suggestion.trim().length >= 20,
          isReelHausPrimaryCategory(lead.category) ||
            lead.category === "local_business"
        ];
        return checks.filter(Boolean).length;
      })
    )
  );
  const personalization = boundedRating(
    average(
      opportunities.map((observation) => {
        const checks = [
          sourceBelongsToLead(lead, observation.sourceUrl),
          observation.detail.trim().length >= 35,
          observation.evidence.trim().length >= 20 &&
            observation.evidence.trim() !== observation.detail.trim(),
          observation.suggestion.trim().length >= 30,
          /[\d«»"“”]|HTTP|Google|WhatsApp|menu|carte|réserv|حجز|قائمة/i.test(
            `${observation.detail} ${observation.evidence}`
          )
        ];
        return checks.filter(Boolean).length;
      })
    )
  );
  return {
    observationQuality,
    businessRelevance,
    personalization,
    confidence,
    missingEvidence: observations.filter(
      (observation) => observation.kind === "coverage_gap"
    ).length
  };
}

export interface CommunicationQualityInput {
  businessName: string;
  city: string;
  firstParagraph: string;
  expectedObservation?: string;
  expectedImpact?: string;
  expectedSuggestion?: string;
}

export function evaluateCommunicationQuality(
  input: CommunicationQualityInput
): {
  evidenceBased: boolean;
  usefulToOwner: boolean;
  businessSpecific: boolean;
  ownerUnderstandable: boolean;
  personalization: number;
  genericLanguagePresent: boolean;
} {
  const evidenceBased = Boolean(
    input.expectedObservation &&
    input.firstParagraph.includes(input.expectedObservation)
  );
  const usefulToOwner = Boolean(
    input.expectedImpact &&
    input.expectedSuggestion &&
    input.firstParagraph.includes(input.expectedImpact) &&
    input.firstParagraph.includes(input.expectedSuggestion)
  );
  const businessSpecific =
    input.firstParagraph.includes(input.businessName) &&
    input.firstParagraph.includes(input.city) &&
    evidenceBased;
  const ownerUnderstandable =
    input.firstParagraph.length >= 60 &&
    input.firstParagraph.length <= 900 &&
    !/\b(?:synergy|disruptive|growth hacking|full-service solution)\b/i.test(
      input.firstParagraph
    );
  const genericLanguagePresent = GENERIC_CUSTOMER_PHRASES.some((pattern) =>
    pattern.test(input.firstParagraph)
  );
  return {
    evidenceBased,
    usefulToOwner,
    businessSpecific,
    ownerUnderstandable,
    personalization: [
      evidenceBased,
      usefulToOwner,
      input.firstParagraph.includes(input.businessName),
      input.firstParagraph.includes(input.city),
      ownerUnderstandable && !genericLanguagePresent
    ].filter(Boolean).length,
    genericLanguagePresent
  };
}

export function reelHausPrioritySummary(): string {
  return [
    "Quality over quantity.",
    "Evidence before recommendation.",
    "Think through guest discovery, decision and action.",
    "Prioritize menu, hours, photos, atmosphere, languages, reservations, WhatsApp, location and trust."
  ].join("\n");
}
