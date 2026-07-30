export type Severity = "critical" | "important" | "optional";
export type EvidenceType = "verified" | "inference";

export interface Finding {
  severity: Severity;
  category:
    | "availability"
    | "links"
    | "metadata"
    | "language"
    | "rtl"
    | "forms"
    | "responsive"
    | "accessibility"
    | "seo";
  page: string;
  title: string;
  detail: string;
  evidence: EvidenceType;
}

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  lang: string;
  dir: string;
  canonical: string;
  h1Count: number;
  internalLinksChecked: number;
  checkedAt: string;
}

export interface ReportSummary {
  critical: number;
  important: number;
  optional: number;
}

export interface AuditReport {
  id: string;
  createdAt: string;
  targets: readonly string[];
  summary: ReportSummary;
  findings: Finding[];
  pages: PageSnapshot[];
  limitations: string[];
  systemInstruction?: string;
}

interface HtmlFacts {
  title: string;
  bodyText: string;
  htmlLang: string;
  htmlDir: string;
  meta: Map<string, string>;
  canonical: string;
  alternates: Map<string, string>;
  h1Count: number;
  images: Array<{ src: string; alt: string | null }>;
  links: Array<{ href: string; text: string; ariaLabel: string | null }>;
  buttons: Array<{ text: string; ariaLabel: string | null }>;
  forms: Array<{
    action: string | null;
    method: string | null;
    controls: Array<{
      id: string | null;
      name: string | null;
      type: string;
      ariaLabel: string | null;
      hasWrappingLabel: boolean;
    }>;
  }>;
  labelFors: Set<string>;
}

const TARGETS = [
  { url: "https://reelhaus.de/fr/", language: "fr", rtl: false },
  { url: "https://reelhaus.de/ar/", language: "ar", rtl: true }
] as const;

const USER_AGENT =
  "ReelHaus-Manager/1.0 (+https://reelhaus.de; read-only website guardian)";
const MAX_HTML_BYTES = 2_000_000;
const MAX_LINKS_PER_PAGE = 60;

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

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isInternalReelHausUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "reelhaus.de" || url.hostname === "www.reelhaus.de")
  );
}

async function fetchPage(
  fetcher: typeof fetch,
  url: string
): Promise<Response> {
  const response = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    redirect: "follow",
    signal: timeoutSignal(15_000)
  });
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_HTML_BYTES) {
    throw new Error(`HTML response exceeds ${MAX_HTML_BYTES} bytes`);
  }
  return response;
}

async function parseHtml(response: Response): Promise<HtmlFacts> {
  const facts: HtmlFacts = {
    title: "",
    bodyText: "",
    htmlLang: "",
    htmlDir: "",
    meta: new Map(),
    canonical: "",
    alternates: new Map(),
    h1Count: 0,
    images: [],
    links: [],
    buttons: [],
    forms: [],
    labelFors: new Set()
  };
  let activeForm: HtmlFacts["forms"][number] | undefined;

  const rewriter = new HTMLRewriter()
    .on("html", {
      element(element) {
        facts.htmlLang = element.getAttribute("lang") || "";
        facts.htmlDir = element.getAttribute("dir") || "";
      }
    })
    .on("title", {
      text(text) {
        facts.title += text.text;
      }
    })
    .on("body", {
      text(text) {
        if (facts.bodyText.length < 250_000) facts.bodyText += text.text + " ";
      }
    })
    .on("meta", {
      element(element) {
        const key = (
          element.getAttribute("name") ||
          element.getAttribute("property") ||
          ""
        ).toLowerCase();
        if (key) facts.meta.set(key, element.getAttribute("content") || "");
      }
    })
    .on("link[rel='canonical']", {
      element(element) {
        facts.canonical = element.getAttribute("href") || "";
      }
    })
    .on("link[rel='alternate'][hreflang]", {
      element(element) {
        const lang = (element.getAttribute("hreflang") || "").toLowerCase();
        if (lang) facts.alternates.set(lang, element.getAttribute("href") || "");
      }
    })
    .on("h1", {
      element() {
        facts.h1Count += 1;
      }
    })
    .on("img", {
      element(element) {
        facts.images.push({
          src: element.getAttribute("src") || "",
          alt: element.getAttribute("alt")
        });
      }
    })
    .on("a[href]", {
      element(element) {
        facts.links.push({
          href: element.getAttribute("href") || "",
          text: "",
          ariaLabel: element.getAttribute("aria-label")
        });
      },
      text(text) {
        const current = facts.links.at(-1);
        if (current) current.text += text.text;
      }
    })
    .on("button", {
      element(element) {
        facts.buttons.push({
          text: "",
          ariaLabel: element.getAttribute("aria-label")
        });
      },
      text(text) {
        const current = facts.buttons.at(-1);
        if (current) current.text += text.text;
      }
    })
    .on("label[for]", {
      element(element) {
        const target = element.getAttribute("for");
        if (target) facts.labelFors.add(target);
      }
    })
    .on("form", {
      element(element) {
        activeForm = {
          action: element.getAttribute("action"),
          method: element.getAttribute("method"),
          controls: []
        };
        facts.forms.push(activeForm);
        element.onEndTag(() => {
          activeForm = undefined;
        });
      }
    })
    .on("form input, form select, form textarea", {
      element(element) {
        activeForm?.controls.push({
          id: element.getAttribute("id"),
          name: element.getAttribute("name"),
          type: (element.getAttribute("type") || element.tagName).toLowerCase(),
          ariaLabel: element.getAttribute("aria-label"),
          hasWrappingLabel: false
        });
      }
    });

  await rewriter.transform(response).arrayBuffer();
  facts.title = cleanText(facts.title);
  facts.bodyText = cleanText(facts.bodyText);
  return facts;
}

async function checkInternalLinks(
  fetcher: typeof fetch,
  pageUrl: string,
  links: HtmlFacts["links"]
): Promise<{ checked: number; findings: Finding[] }> {
  const urls = new Set<string>();
  for (const link of links) {
    try {
      const resolved = new URL(link.href, pageUrl);
      resolved.hash = "";
      if (isInternalReelHausUrl(resolved)) urls.add(resolved.toString());
    } catch {
      // Invalid href is reported below by the markup checks.
    }
  }
  const selected = [...urls].slice(0, MAX_LINKS_PER_PAGE);
  const findings: Finding[] = [];

  for (let index = 0; index < selected.length; index += 6) {
    const batch = selected.slice(index, index + 6);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        const response = await fetcher(url, {
          method: "HEAD",
          redirect: "follow",
          headers: { "user-agent": USER_AGENT },
          signal: timeoutSignal(8_000)
        });
        return { url, status: response.status };
      })
    );
    results.forEach((result, resultIndex) => {
      const url = batch[resultIndex];
      if (result.status === "rejected") {
        findings.push(
          finding(
            "important",
            "links",
            pageUrl,
            "Interner Link konnte nicht geprüft werden",
            `${url}: ${String(result.reason)}`
          )
        );
      } else if (result.value.status >= 400) {
        findings.push(
          finding(
            result.value.status >= 500 ? "critical" : "important",
            "links",
            pageUrl,
            "Interner Link ist nicht erreichbar",
            `${url} antwortete mit HTTP ${result.value.status}.`
          )
        );
      }
    });
  }
  return { checked: selected.length, findings };
}

function inspectFacts(
  pageUrl: string,
  language: "fr" | "ar",
  expectsRtl: boolean,
  facts: HtmlFacts
): Finding[] {
  const issues: Finding[] = [];
  const description = facts.meta.get("description") || "";
  const viewport = facts.meta.get("viewport") || "";
  const arabicChars = (facts.bodyText.match(/[\u0600-\u06ff]/g) || []).length;
  const latinChars = (facts.bodyText.match(/[A-Za-zÀ-ÿ]/g) || []).length;

  if (!facts.title) {
    issues.push(
      finding("important", "metadata", pageUrl, "Seitentitel fehlt", "Kein <title> gefunden.")
    );
  } else if (facts.title.length < 15 || facts.title.length > 65) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Seitentitel-Länge prüfen",
        `Der Titel hat ${facts.title.length} Zeichen; üblich sind etwa 15–65.`
      )
    );
  }
  if (!description) {
    issues.push(
      finding("important", "metadata", pageUrl, "Meta-Description fehlt", "Keine Meta-Description gefunden.")
    );
  } else if (description.length < 70 || description.length > 170) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Meta-Description-Länge prüfen",
        `Die Description hat ${description.length} Zeichen; üblich sind etwa 70–170.`
      )
    );
  }
  if (!facts.canonical) {
    issues.push(
      finding("important", "seo", pageUrl, "Canonical URL fehlt", "Kein rel=canonical gefunden.")
    );
  }
  if (!facts.htmlLang.toLowerCase().startsWith(language)) {
    issues.push(
      finding(
        "important",
        "language",
        pageUrl,
        "Dokumentsprache stimmt nicht",
        `Erwartet wurde lang="${language}", gefunden wurde "${facts.htmlLang || "kein Wert"}".`
      )
    );
  }
  if (expectsRtl && facts.htmlDir.toLowerCase() !== "rtl") {
    issues.push(
      finding("critical", "rtl", pageUrl, "Arabische Seite ist nicht als RTL markiert", 'Am <html>-Element fehlt dir="rtl".')
    );
  }
  if (!expectsRtl && facts.htmlDir.toLowerCase() === "rtl") {
    issues.push(
      finding("important", "rtl", pageUrl, "Französische Seite ist als RTL markiert", 'dir="rtl" ist für die französische Seite unerwartet.')
    );
  }
  if (language === "ar" && latinChars > arabicChars * 2 && latinChars > 200) {
    issues.push(
      finding(
        "important",
        "language",
        pageUrl,
        "Arabischer Inhalt wirkt sprachlich inkonsistent",
        `Zeichen-Heuristik: ${arabicChars} arabische und ${latinChars} lateinische Buchstaben.`,
        "inference"
      )
    );
  }
  if (language === "fr" && arabicChars > latinChars && arabicChars > 200) {
    issues.push(
      finding(
        "important",
        "language",
        pageUrl,
        "Französischer Inhalt wirkt sprachlich inkonsistent",
        `Zeichen-Heuristik: ${latinChars} lateinische und ${arabicChars} arabische Buchstaben.`,
        "inference"
      )
    );
  }
  if (!viewport.toLowerCase().includes("width=device-width")) {
    issues.push(
      finding("critical", "responsive", pageUrl, "Mobiler Viewport fehlt", 'Meta viewport mit "width=device-width" wurde nicht gefunden.')
    );
  }
  issues.push(
    finding(
      "optional",
      "responsive",
      pageUrl,
      "Visuelles responsives Layout manuell prüfen",
      "Ein Worker analysiert HTML, rendert aber keine Browser-Viewports. Überläufe, Touch-Ziele und Breakpoints sind daher nicht visuell verifiziert.",
      "inference"
    )
  );
  if (facts.h1Count !== 1) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "H1-Struktur prüfen",
        `Gefundene H1-Überschriften: ${facts.h1Count}; erwartet wird eine klare Hauptüberschrift.`
      )
    );
  }
  const missingAlts = facts.images.filter((image) => image.alt === null);
  if (missingAlts.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Bilder ohne alt-Attribut",
        `${missingAlts.length} von ${facts.images.length} Bildern haben kein alt-Attribut.`
      )
    );
  }
  const emptyLinks = facts.links.filter(
    (link) => !cleanText(link.text) && !link.ariaLabel
  );
  if (emptyLinks.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Links ohne zugänglichen Namen",
        `${emptyLinks.length} Links enthalten weder Text noch aria-label.`
      )
    );
  }
  const emptyButtons = facts.buttons.filter(
    (button) => !cleanText(button.text) && !button.ariaLabel
  );
  if (emptyButtons.length) {
    issues.push(
      finding(
        "important",
        "accessibility",
        pageUrl,
        "Buttons ohne zugänglichen Namen",
        `${emptyButtons.length} Buttons enthalten weder Text noch aria-label.`
      )
    );
  }
  for (const [index, form] of facts.forms.entries()) {
    const unlabeled = form.controls.filter(
      (control) =>
        control.type !== "hidden" &&
        !control.ariaLabel &&
        !control.hasWrappingLabel &&
        (!control.id || !facts.labelFors.has(control.id))
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
          `Formular ${index + 1} enthält unbeschriftete Felder`,
          `${unlabeled.length} Formularelemente haben keine erkennbare Beschriftung.`
        )
      );
    }
    if (unnamed.length) {
      issues.push(
        finding(
          "important",
          "forms",
          pageUrl,
          `Formular ${index + 1} enthält Felder ohne name`,
          `${unnamed.length} Formularelemente können ohne name nicht regulär übertragen werden.`
        )
      );
    }
    if ((form.method || "get").toLowerCase() === "get") {
      issues.push(
        finding(
          "optional",
          "forms",
          pageUrl,
          `Formular ${index + 1} verwendet GET oder keine Methode`,
          "Bei personenbezogenen oder längeren Eingaben sollte die beabsichtigte Methode geprüft werden.",
          "inference"
        )
      );
    }
  }
  if (!facts.alternates.has("fr") || !facts.alternates.has("ar")) {
    issues.push(
      finding(
        "important",
        "seo",
        pageUrl,
        "hreflang-Verknüpfung unvollständig",
        "Beide Sprachalternativen fr und ar sollten per hreflang referenziert sein."
      )
    );
  }
  if (!facts.meta.get("og:title") || !facts.meta.get("og:description")) {
    issues.push(
      finding(
        "optional",
        "seo",
        pageUrl,
        "Open-Graph-Metadaten unvollständig",
        "og:title und/oder og:description fehlen."
      )
    );
  }
  return issues;
}

export function summarizeFindings(findings: Finding[]): ReportSummary {
  return findings.reduce<ReportSummary>(
    (summary, item) => {
      summary[item.severity] += 1;
      return summary;
    },
    { critical: 0, important: 0, optional: 0 }
  );
}

export async function analyzeReelHaus(
  fetcher: typeof fetch
): Promise<AuditReport> {
  const findings: Finding[] = [];
  const pages: PageSnapshot[] = [];

  for (const target of TARGETS) {
    try {
      const response = await fetchPage(fetcher, target.url);
      if (!response.ok) {
        findings.push(
          finding(
            response.status >= 500 ? "critical" : "important",
            "availability",
            target.url,
            "Zielseite ist nicht erfolgreich erreichbar",
            `HTTP ${response.status} ${response.statusText}`
          )
        );
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/html")) {
        findings.push(
          finding(
            "critical",
            "availability",
            target.url,
            "Zielseite liefert kein HTML",
            `Content-Type: ${contentType || "nicht gesetzt"}`
          )
        );
        continue;
      }
      const finalUrl = response.url || target.url;
      const facts = await parseHtml(response);
      findings.push(
        ...inspectFacts(target.url, target.language, target.rtl, facts)
      );
      const linkResult = await checkInternalLinks(
        fetcher,
        finalUrl,
        facts.links
      );
      findings.push(...linkResult.findings);
      pages.push({
        url: target.url,
        finalUrl,
        status: response.status,
        title: facts.title,
        description: facts.meta.get("description") || "",
        lang: facts.htmlLang,
        dir: facts.htmlDir,
        canonical: facts.canonical,
        h1Count: facts.h1Count,
        internalLinksChecked: linkResult.checked,
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      findings.push(
        finding(
          "critical",
          "availability",
          target.url,
          "Zielseite konnte nicht analysiert werden",
          error instanceof Error ? error.message : "Unbekannter Abruffehler"
        )
      );
    }
  }

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    targets: TARGETS.map((target) => target.url),
    summary: summarizeFindings(findings),
    findings,
    pages,
    limitations: [
      "Die Prüfung ist vollständig read-only und verändert keine Website-Daten.",
      "Responsive Layout, Kontrast, Fokusreihenfolge und clientseitige Interaktion werden ohne echten Browser nicht visuell verifiziert.",
      `Pro Seite werden höchstens ${MAX_LINKS_PER_PAGE} interne HTTPS-Links geprüft; externe Links werden aus Sicherheitsgründen nicht abgerufen.`,
      "Formulare werden nur strukturell geprüft und niemals abgesendet."
    ]
  };
}
