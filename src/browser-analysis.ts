import puppeteer from "@cloudflare/puppeteer";
import type {
  EvidenceConfidence,
  GuestJourneyStage,
  ObservedIssue,
  PublicWebsiteObservation
} from "./sales-types";

const MAX_PAGE_BYTES = 2_000_000;

function attribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  );
  return match?.[1] || match?.[2] || match?.[3] || "";
}

function textContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

type PageSignals = Omit<
  PublicWebsiteObservation,
  "websiteUrl" | "sourceUrl" | "observedAt" | "issues"
>;

function gastronomyObservations(
  result: PageSignals,
  sourceUrl: string,
  observedAt: string,
  absenceConfidence: EvidenceConfidence
): ObservedIssue[] {
  const observations: ObservedIssue[] = [];
  const add = (input: {
    code: string;
    signal: string;
    journeyStage: GuestJourneyStage;
    detail: string;
    evidence: string;
    impact: string;
    suggestion: string;
    confidence: EvidenceConfidence;
    kind: "opportunity" | "strength" | "coverage_gap";
    points?: number;
    verified?: boolean;
  }) =>
    observations.push({
      ...input,
      sourceUrl,
      observedAt,
      points: input.points || 0,
      verified: input.verified ?? input.kind !== "coverage_gap"
    });
  const binary = (input: {
    present: boolean;
    signal: string;
    journeyStage: GuestJourneyStage;
    presentCode: string;
    missingCode: string;
    presentDetail: string;
    missingDetail: string;
    evidence: string;
    impact: string;
    suggestion: string;
    points: number;
    presentConfidence?: EvidenceConfidence;
    missingConfidence?: EvidenceConfidence;
  }) =>
    add({
      code: input.present ? input.presentCode : input.missingCode,
      signal: input.signal,
      journeyStage: input.journeyStage,
      detail: input.present ? input.presentDetail : input.missingDetail,
      evidence: input.evidence,
      impact: input.impact,
      suggestion: input.suggestion,
      confidence: input.present
        ? input.presentConfidence || "High"
        : input.missingConfidence || absenceConfidence,
      kind: input.present ? "strength" : "opportunity",
      points: input.present ? 0 : input.points
    });

  if (!result.mobileViewport)
    add({
      code: "mobile_viewport",
      signal: "menu_accessibility",
      journeyStage: "guest_decision",
      detail: "Im öffentlichen HTML fehlt ein mobiler Viewport.",
      evidence: "Kein viewport-Meta-Element mit width=device-width erkannt.",
      impact: "Mobile Gäste können Inhalte und Aktionen schlechter nutzen.",
      suggestion: "Die Seite mit einem korrekten mobilen Viewport ausliefern.",
      confidence: "High",
      kind: "opportunity",
      points: 20
    });

  binary({
    present: Boolean(
      result.publicEmails.length ||
        result.phones.length ||
        result.contactLinks.length
    ),
    signal: "contact_availability",
    journeyStage: "guest_discovery",
    presentCode: "contact_available",
    missingCode: "contact_missing",
    presentDetail: "Ein öffentlicher Kontaktweg wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein klarer Kontaktweg erkannt.",
    evidence: `${result.publicEmails.length} E-Mail-, ${result.phones.length} Telefon- und ${result.contactLinks.length} Kontaktlinks`,
    impact: "Ein klarer Kontaktweg reduziert Unsicherheit vor einem Besuch.",
    suggestion: "Öffentliche Kontaktdaten sichtbar und aktuell halten.",
    points: 12
  });
  binary({
    present: result.mapsLinks.length > 0,
    signal: "location_information",
    journeyStage: "guest_discovery",
    presentCode: "location_available",
    missingCode: "location_missing",
    presentDetail: "Ein öffentlicher Karten- oder Standortlink wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein Karten- oder Standortlink erkannt.",
    evidence: result.mapsLinks[0] || "Kein Kartenlink in den geprüften Links.",
    impact: "Standortinformationen helfen Gästen bei Auswahl und Anfahrt.",
    suggestion: "Adresse und direkten Kartenlink gemeinsam anzeigen.",
    points: 8
  });
  binary({
    present: result.hasMenuLink,
    signal: "menu_accessibility",
    journeyStage: "guest_decision",
    presentCode: "menu_available",
    missingCode: "menu_missing",
    presentDetail: "Ein Menü- oder Kartenlink wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein Menü-/Kartenlink erkannt.",
    evidence: result.hasMenuLink
      ? "Menübezug in Linktext oder Linkziel erkannt."
      : "Kein Menübezug in den geprüften Links.",
    impact: "Die Karte ist ein zentraler Entscheidungsfaktor für Restaurantgäste.",
    suggestion: "Eine mobil lesbare Karte direkt verlinken.",
    points: 10
  });
  binary({
    present: result.hasFoodServiceInfo || result.hasOpeningHours,
    signal: "food_service_information",
    journeyStage: "guest_decision",
    presentCode: "food_info_available",
    missingCode: "food_info_missing",
    presentDetail: "Informationen zu Küche, Angebot oder Service wurden erkannt.",
    missingDetail: "Küche, Angebot und Service sind auf der geprüften Seite nicht klar erkennbar.",
    evidence: result.hasOpeningHours
      ? "Öffnungszeiten oder Servicebegriffe im Seitentext erkannt."
      : "Keine eindeutigen Angebots- oder Servicebegriffe erkannt.",
    impact: "Konkrete Angebotsinformationen helfen Gästen, die Eignung einzuschätzen.",
    suggestion: "Küche, Spezialitäten, Öffnungszeiten und Service konkret nennen.",
    points: 8
  });
  binary({
    present: result.imageCount >= 3,
    signal: "photos",
    journeyStage: "guest_decision",
    presentCode: "photos_available",
    missingCode: "photos_missing",
    presentDetail: `${result.imageCount} Bilder wurden auf der Seite erkannt.`,
    missingDetail: `Nur ${result.imageCount} Bilder wurden auf der Seite erkannt.`,
    evidence: `${result.imageCount} img-Elemente im geprüften Dokument.`,
    impact: "Fotos vermitteln Gästen Angebot und Atmosphäre.",
    suggestion: "Aktuelle Fotos von Speisen, Raum und Service anbieten.",
    points: 8,
    presentConfidence: "High",
    missingConfidence: "High"
  });
  if (result.imagesMissingAlt)
    add({
      code: "image_alt",
      signal: "photos",
      journeyStage: "guest_decision",
      detail: `${result.imagesMissingAlt} Bilder ohne alt-Attribut.`,
      evidence: `${result.imagesMissingAlt} img-Elemente ohne alt-Attribut.`,
      impact: "Bildinhalte bleiben für Gäste mit assistiven Technologien unverständlich.",
      suggestion: "Aussagekräftige alt-Texte ergänzen.",
      confidence: "High",
      kind: "opportunity",
      points: Math.min(10, result.imagesMissingAlt * 2)
    });
  binary({
    present: Boolean(result.language),
    signal: "languages",
    journeyStage: "guest_decision",
    presentCode: "language_declared",
    missingCode: "language_missing",
    presentDetail: `Die Seitensprache ist als ${result.language} ausgezeichnet.`,
    missingDetail: "Die Seitensprache ist im HTML nicht ausgezeichnet.",
    evidence: result.language || "Kein lang-Attribut am html-Element.",
    impact: "Eine korrekte Sprachangabe unterstützt Browser und Hilfstechnologien.",
    suggestion: "Seitensprache und Sprachwechsel korrekt auszeichnen.",
    points: 8,
    presentConfidence: "High",
    missingConfidence: "High"
  });
  binary({
    present: result.hasTrustSignals,
    signal: "trust_signals",
    journeyStage: "guest_decision",
    presentCode: "trust_signals_available",
    missingCode: "trust_signals_missing",
    presentDetail: "Ein öffentliches Vertrauenssignal wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein eindeutiges Vertrauenssignal erkannt.",
    evidence: result.hasTrustSignals
      ? "Bewertungs-, Presse- oder Herkunftsbezug im Seitentext erkannt."
      : "Kein eindeutiger Bewertungs-, Presse- oder Herkunftsbezug erkannt.",
    impact: "Nachprüfbare Signale helfen neuen Gästen bei der Entscheidung.",
    suggestion: "Nur echte, nachprüfbare Bewertungen oder Herkunftsinformationen verlinken.",
    points: 5
  });
  binary({
    present: result.phones.length > 0,
    signal: "phone",
    journeyStage: "guest_action",
    presentCode: "phone_available",
    missingCode: "phone_missing",
    presentDetail: "Eine klickbare öffentliche Telefonnummer wurde erkannt.",
    missingDetail: "Keine klickbare öffentliche Telefonnummer wurde erkannt.",
    evidence: result.phones[0] || "Kein tel-Link in den geprüften Links.",
    impact: "Telefonkontakt unterstützt kurzfristige Fragen und Reservierungen.",
    suggestion: "Eine klickbare öffentliche Telefonnummer ergänzen.",
    points: 8
  });
  binary({
    present: result.whatsappLinks.length > 0,
    signal: "whatsapp",
    journeyStage: "guest_action",
    presentCode: "whatsapp_available",
    missingCode: "whatsapp_missing",
    presentDetail: "Ein öffentlicher WhatsApp-Link wurde erkannt.",
    missingDetail: "Kein öffentlicher WhatsApp-Link wurde erkannt.",
    evidence: result.whatsappLinks[0] || "Kein WhatsApp-Link in den geprüften Links.",
    impact: "WhatsApp kann für mobile Gäste ein direkter Kontaktweg sein.",
    suggestion: "WhatsApp nur bei betreutem Geschäftskanal verlinken.",
    points: 5
  });
  binary({
    present: result.hasReservationLink,
    signal: "reservation",
    journeyStage: "guest_action",
    presentCode: "reservation_available",
    missingCode: "reservation_missing",
    presentDetail: "Ein Reservierungsweg wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein eindeutiger Reservierungsweg erkannt.",
    evidence: result.hasReservationLink
      ? "Reservierungsbezug in Linktext oder Linkziel erkannt."
      : "Kein Reservierungsbezug in den geprüften Links.",
    impact: "Ein klarer Reservierungsweg unterstützt Gäste mit konkreter Besuchsabsicht.",
    suggestion: "Reservierungsbutton oder klare Reservierungsanweisung anbieten.",
    points: 10
  });
  binary({
    present: result.hasOrderingLink,
    signal: "ordering",
    journeyStage: "guest_action",
    presentCode: "ordering_available",
    missingCode: "ordering_missing",
    presentDetail: "Ein Bestellweg wurde erkannt.",
    missingDetail: "Auf der geprüften Seite wurde kein Bestellweg erkannt.",
    evidence: result.hasOrderingLink
      ? "Bestellbezug in Linktext oder Linkziel erkannt."
      : "Kein Bestellbezug in den geprüften Links.",
    impact: "Ein klarer Bestellweg hilft Gästen, wenn dieser Service angeboten wird.",
    suggestion: "Bestellmöglichkeiten nur bei tatsächlich vorhandenem Service verlinken.",
    points: 4
  });
  binary({
    present: result.mapsLinks.length > 0,
    signal: "directions",
    journeyStage: "guest_action",
    presentCode: "directions_available",
    missingCode: "directions_missing",
    presentDetail: "Ein direkter Kartenlink unterstützt die Anfahrt.",
    missingDetail: "Kein direkter Karten- oder Routenlink wurde erkannt.",
    evidence: result.mapsLinks[0] || "Kein Kartenlink in den geprüften Links.",
    impact: "Ein Routenlink verkürzt den Weg von der Entscheidung zum Besuch.",
    suggestion: "Einen direkten Routenlink neben der Adresse platzieren.",
    points: 8
  });
  return observations;
}

async function analyzePublicHtml(
  url: URL
): Promise<PublicWebsiteObservation> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "ReelHaus-Manager/1.0 public-business-audit"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Website returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html"))
    throw new Error("Website did not return HTML");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_PAGE_BYTES)
    throw new Error("Website HTML exceeds the analysis size limit");
  const html = await response.text();
  if (new TextEncoder().encode(html).byteLength > MAX_PAGE_BYTES)
    throw new Error("Website HTML exceeds the analysis size limit");

  const observedAt = new Date().toISOString();
  const finalUrl = new URL(response.url || url.toString());
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || "";
  const title = textContent(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] || "");
  const bodyText = textContent(html);
  const links = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((match) => {
    const href = attribute(match[0], "href");
    let absolute = "";
    try {
      absolute = href ? new URL(href, finalUrl).toString() : "";
    } catch {
      // Invalid public markup is ignored rather than guessed.
    }
    return { href: absolute, text: textContent(match[0]) };
  });
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const viewportTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const mobileViewport = viewportTags.some(
    (tag) =>
      attribute(tag, "name").toLowerCase() === "viewport" &&
      /width\s*=\s*device-width/i.test(attribute(tag, "content"))
  );
  const hasMenuLink = links.some((link) =>
    /menu|carte|قائمة/i.test(`${link.text} ${link.href}`)
  );
  const hasOpeningHours =
    /horaires|ouvert|opening hours|opening times|ساعات|مفتوح/i.test(bodyText);
  const hasFoodServiceInfo =
    /restaurant|café|cafe|cuisine|menu|carte|petit[- ]déjeuner|déjeuner|dîner|brunch|pâtisserie|مقهى|مطعم|قائمة|مطبخ/i.test(
      bodyText
    );
  const hasTrustSignals =
    /avis|review|tripadvisor|google reviews|témoignage|presse|award|prix|تقييم|آراء/i.test(
      bodyText
    );
  const hasReservationLink = links.some((link) =>
    /réserv|reserv|booking|book a table|حجز/i.test(`${link.text} ${link.href}`)
  );
  const hasOrderingLink = links.some((link) =>
    /command|order|delivery|livraison|takeaway|طلب|توصيل/i.test(
      `${link.text} ${link.href}`
    )
  );
  const publicEmails = unique(
    links
      .filter((link) => link.href.toLowerCase().startsWith("mailto:"))
      .map((link) => link.href.slice(7).split("?")[0])
  );
  const phones = unique(
    links
      .filter((link) => link.href.toLowerCase().startsWith("tel:"))
      .map((link) => link.href.slice(4))
  );
  const whatsappLinks = unique(
    links.filter((link) => /wa\.me|whatsapp\.com/i.test(link.href)).map((link) => link.href)
  );
  const contactLinks = unique(
    links
      .filter((link) => /contact|اتصل/i.test(`${link.text} ${link.href}`))
      .map((link) => link.href)
  );
  const mapsLinks = unique(
    links
      .filter((link) => /google\.[^/]+\/maps|maps\.app\.goo\.gl/i.test(link.href))
      .map((link) => link.href)
  );
  const imagesMissingAlt = images.filter((image) => !/\balt\s*=/i.test(image)).length;
  const result: PageSignals = {
    title,
    language: attribute(htmlTag, "lang"),
    mobileViewport,
    hasMenuLink,
    hasOpeningHours,
    hasFoodServiceInfo,
    hasTrustSignals,
    hasReservationLink,
    hasOrderingLink,
    imageCount: images.length,
    imagesMissingAlt,
    publicEmails,
    phones,
    whatsappLinks,
    contactLinks,
    mapsLinks
  };
  return {
    websiteUrl: finalUrl.toString(),
    sourceUrl: finalUrl.toString(),
    observedAt,
    ...result,
    issues: gastronomyObservations(
      result,
      finalUrl.toString(),
      observedAt,
      "Low"
    )
  };
}

function robotsAllows(robots: string, pathname: string): boolean {
  let applies = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (field?.toLowerCase() === "user-agent") {
      applies = value === "*";
    } else if (
      applies &&
      field?.toLowerCase() === "disallow" &&
      value &&
      pathname.startsWith(value)
    ) {
      return false;
    }
  }
  return true;
}

export async function analyzePublicBusinessWebsite(
  browserBinding: BrowserRun | Fetcher,
  websiteUrl: string
): Promise<PublicWebsiteObservation> {
  const url = new URL(websiteUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only public HTTP(S) websites can be analyzed");
  }
  const robotsUrl = new URL("/robots.txt", url);
  const robotsResponse = await fetch(robotsUrl, {
    headers: { "user-agent": "ReelHaus-Manager/1.0" },
    signal: AbortSignal.timeout(8_000)
  });
  if (robotsResponse.ok) {
    const length = Number(robotsResponse.headers.get("content-length") || 0);
    if (length <= MAX_PAGE_BYTES) {
      const robots = await robotsResponse.text();
      if (!robotsAllows(robots, url.pathname)) {
        throw new Error("robots.txt disallows this page");
      }
    }
  }

  // Wrangler's BrowserRun and Puppeteer's Fetcher declarations describe the
  // same runtime binding but currently expose different helper methods.
  let browser;
  try {
    browser = await puppeteer.launch(browserBinding as unknown as Fetcher);
  } catch (error) {
    console.warn("Browser rendering unavailable; using limited HTML analysis", {
      reason: error instanceof Error ? error.message : "unknown"
    });
    return analyzePublicHtml(url);
  }
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.setUserAgent("ReelHaus-Manager/1.0 public-business-audit");
    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 20_000
    });
    if (!response || response.status() >= 400) {
      throw new Error(`Website returned HTTP ${response?.status() || "unknown"}`);
    }
    const observedAt = new Date().toISOString();
    const result = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const hrefs = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(
        (link) => ({ href: link.href, text: (link.innerText || "").trim() })
      );
      const emails = hrefs
        .filter((link) => link.href.startsWith("mailto:"))
        .map((link) => link.href.slice(7).split("?")[0]);
      const phones = hrefs
        .filter((link) => link.href.startsWith("tel:"))
        .map((link) => link.href.slice(4));
      const images = [...document.images];
      return {
        title: document.title,
        language: document.documentElement.lang || "",
        mobileViewport: !!document.querySelector(
          'meta[name="viewport"][content*="width=device-width"]'
        ),
        hasMenuLink: hrefs.some((link) =>
          /menu|carte|قائمة/i.test(`${link.text} ${link.href}`)
        ),
        hasOpeningHours: /horaires|ouvert|opening hours|ساعات|مفتوح/i.test(text),
        hasFoodServiceInfo:
          /restaurant|café|cafe|cuisine|menu|carte|petit[- ]déjeuner|déjeuner|dîner|brunch|pâtisserie|مقهى|مطعم|قائمة|مطبخ/i.test(
            text
          ),
        hasTrustSignals:
          /avis|review|tripadvisor|google reviews|témoignage|presse|award|prix|تقييم|آراء/i.test(
            text
          ),
        hasReservationLink: hrefs.some((link) =>
          /réserv|reserv|booking|book a table|حجز/i.test(
            `${link.text} ${link.href}`
          )
        ),
        hasOrderingLink: hrefs.some((link) =>
          /command|order|delivery|livraison|takeaway|طلب|توصيل/i.test(
            `${link.text} ${link.href}`
          )
        ),
        imageCount: images.length,
        imagesMissingAlt: images.filter((image) => !image.hasAttribute("alt")).length,
        publicEmails: [...new Set(emails)],
        phones: [...new Set(phones)],
        whatsappLinks: hrefs
          .filter((link) => /wa\.me|whatsapp\.com/i.test(link.href))
          .map((link) => link.href),
        contactLinks: hrefs
          .filter((link) => /contact|اتصل/i.test(`${link.text} ${link.href}`))
          .map((link) => link.href),
        mapsLinks: hrefs
          .filter((link) => /google\.[^/]+\/maps|maps\.app\.goo\.gl/i.test(link.href))
          .map((link) => link.href)
      };
    });
    return {
      websiteUrl: url.toString(),
      sourceUrl: url.toString(),
      observedAt,
      ...result,
      issues: gastronomyObservations(
        result,
        url.toString(),
        observedAt,
        "Medium"
      )
    };
  } catch (error) {
    console.warn("Browser rendering failed; using limited HTML analysis", {
      reason: error instanceof Error ? error.message : "unknown"
    });
    return analyzePublicHtml(url);
  } finally {
    await browser.close();
  }
}

export { robotsAllows };
