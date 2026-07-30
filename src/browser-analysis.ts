import puppeteer from "@cloudflare/puppeteer";
import type { ObservedIssue, PublicWebsiteObservation } from "./sales-types";

const MAX_PAGE_BYTES = 2_000_000;

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
  const browser = await puppeteer.launch(browserBinding as unknown as Fetcher);
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
    const issues: ObservedIssue[] = [];
    const add = (code: string, detail: string, points: number) =>
      issues.push({
        code,
        detail,
        points,
        sourceUrl: url.toString(),
        observedAt,
        verified: true
      });
    if (!result.mobileViewport) add("mobile_viewport", "Mobiler Viewport fehlt.", 20);
    if (!result.hasMenuLink) add("menu_missing", "Kein Menü-/Kartenlink erkannt.", 8);
    if (!result.hasOpeningHours)
      add("hours_missing", "Keine Öffnungszeiten erkannt.", 8);
    if (!result.whatsappLinks.length)
      add("whatsapp_missing", "Kein öffentlicher WhatsApp-Link erkannt.", 5);
    if (result.imagesMissingAlt)
      add(
        "image_alt",
        `${result.imagesMissingAlt} Bilder ohne alt-Attribut.`,
        Math.min(10, result.imagesMissingAlt * 2)
      );
    return {
      websiteUrl: url.toString(),
      sourceUrl: url.toString(),
      observedAt,
      ...result,
      issues
    };
  } finally {
    await browser.close();
  }
}

export { robotsAllows };
