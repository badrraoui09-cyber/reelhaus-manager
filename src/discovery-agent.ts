import { leadDedupeKey, normalizeUrl } from "./sales-policy";
import { safeFetchPublicUrl } from "./safe-fetch";
import { validatePublicScanUrl } from "./url-safety";
import type {
  DiscoveryCandidate,
  DiscoveryCandidateInput,
  DiscoveryStatus,
  EvidenceConfidence,
  LeadCategory,
  ObservedIssue
} from "./sales-types";

export const AUTONOMOUS_DISCOVERY_VERSION = "1.0" as const;
export const MAX_DISCOVERY_SOURCE_PAGES_PER_RUN = 5;
export const ACTIVE_DISCOVERY_COUNTRIES = ["MA"] as const;
const MAX_SOURCE_HTML_BYTES = 1_000_000;
const MAX_OVERPASS_JSON_BYTES = 1_000_000;
const OPENSTREETMAP_OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter"
] as const;

export const MOROCCO_DISCOVERY_LOCATIONS = [
  { city: "Casablanca", south: 33.58, west: -7.63, north: 33.60, east: -7.60 },
  { city: "Marrakech", south: 31.62, west: -8.00, north: 31.64, east: -7.97 },
  { city: "Rabat", south: 33.99, west: -6.86, north: 34.02, east: -6.82 },
  { city: "Fès", south: 34.03, west: -5.02, north: 34.06, east: -4.98 },
  { city: "Tangier", south: 35.76, west: -5.84, north: 35.79, east: -5.80 },
  { city: "Agadir", south: 30.40, west: -9.62, north: 30.43, east: -9.58 },
  { city: "Essaouira", south: 31.50, west: -9.78, north: 31.52, east: -9.75 }
] as const;

const HOSPITALITY_CATEGORIES = new Set<LeadCategory>([
  "restaurant",
  "cafe",
  "bakery",
  "snack",
  "beach_club",
  "rooftop_restaurant",
  "riad",
  "small_hotel"
]);

export interface DiscoveryDecision {
  accepted: boolean;
  confidence: EvidenceConfidence;
  reasons: string[];
  normalized: DiscoveryCandidateInput;
}

export interface PublicSourceResult {
  sourceUrl: string;
  candidates: DiscoveryCandidateInput[];
  skippedReason?: string;
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OsmResponse {
  elements?: OsmElement[];
}

interface WikidataBindingValue {
  value?: string;
  "xml:lang"?: string;
}

interface WikidataResponse {
  results?: {
    bindings?: Array<{
      item?: WikidataBindingValue;
      itemLabel?: WikidataBindingValue;
      website?: WikidataBindingValue;
      coord?: WikidataBindingValue;
      locationLabel?: WikidataBindingValue;
    }>;
  };
}

export interface DiscoveryPriority {
  score: number;
  baseScore: number;
  learningAdjustment: number;
  reasons: string[];
}

export interface DiscoveryLearningStats {
  approved: number;
  rejected: number;
  ignored: number;
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.map((value) => value?.trim() || "").filter(Boolean))
  ];
}

function publicUrl(value?: string): string {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  const host = new URL(normalized).hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    return "";
  return normalized;
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

// Task #6B (privacy-minimized Discovery v1): Discovery must not intentionally
// collect or persist contact/person data, exact coordinates, or social/
// booking arrays — even when a public source provides them. This is the one
// choke point every extraction path (OSM, Wikidata, JSON-LD, the manual
// queue) normalizes through before storage, so stripping these fields here
// is sufficient to keep them out of every Discovery write. Existing DB
// columns for these fields stay nullable for schema compatibility; new
// Discovery writes simply leave them empty. Historical rows are untouched.
export function normalizeDiscoveryCandidate(
  input: DiscoveryCandidateInput
): DiscoveryCandidateInput {
  return {
    ...input,
    businessName: input.businessName?.trim() || "",
    city: input.city?.trim() || "",
    country: (input.country || "MA").trim().toUpperCase(),
    websiteUrl: publicUrl(input.websiteUrl) || undefined,
    // Intentionally dropped for privacy-minimized v1, regardless of input:
    mapsUrl: undefined,
    publicEmail: undefined,
    phone: undefined,
    whatsapp: undefined,
    socialLinks: [],
    bookingLinks: [],
    latitude: undefined,
    longitude: undefined,
    languagesDetected: unique(input.languagesDetected || []).map((language) =>
      language.toLocaleLowerCase()
    ),
    sourceUrls: unique(input.sourceUrls || [])
      .map(publicUrl)
      .filter(Boolean),
    discoverySource:
      publicUrl(input.discoverySource) ||
      unique(input.sourceUrls || [])
        .map(publicUrl)
        .find(Boolean) ||
      undefined,
    language: input.language || "fr",
    pilot: Boolean(input.pilot),
    closed: Boolean(input.closed)
  };
}

// Preferred business-level identity for dedupe: website hostname when
// available, otherwise business name + city. No longer depends on contact
// data (phone/email) or precise location (coordinates/maps link) — those
// fields are no longer collected by Discovery v1 (see
// normalizeDiscoveryCandidate above).
export function discoveryIdentityKeys(
  input: DiscoveryCandidateInput
): string[] {
  const normalized = normalizeDiscoveryCandidate(input);
  if (normalized.websiteUrl)
    return [
      `website:${new URL(normalized.websiteUrl).hostname.replace(/^www\./, "")}`
    ];
  return [
    `name-city:${normalizedName(normalized.businessName)}|${normalizedName(normalized.city)}`
  ];
}

export function discoveryDedupeKey(input: DiscoveryCandidateInput): string {
  return discoveryIdentityKeys(input)[0] || "invalid:unknown";
}

// Checked against already-promoted `leads` rows only (historical data —
// Discovery-to-Lead promotion itself is disabled, see sales-agent.ts). No
// longer passes contact data through: leadDedupeKey() already prefers
// website, then falls back to name+city once email is absent.
export function discoveryLeadDedupeKey(input: DiscoveryCandidateInput): string {
  const normalized = normalizeDiscoveryCandidate(input);
  return leadDedupeKey({
    businessName: normalized.businessName,
    category: normalized.category,
    city: normalized.city,
    country: "MA",
    websiteUrl: normalized.websiteUrl,
    sourceUrls: normalized.sourceUrls,
    language: normalized.language,
    pilot: normalized.pilot
  });
}

export function discoveryCandidateIsCrmVisible(
  status: DiscoveryStatus
): boolean {
  return status === "approved" || status === "qualified";
}

export function discoveryCandidateCanBeApproved(
  candidate: Pick<DiscoveryCandidate, "status" | "leadId">,
  hasQualificationRecommendation: boolean
): boolean {
  return Boolean(
    candidate.leadId &&
    ["scanned", "sent_to_reelscan", "qualified"].includes(candidate.status) &&
    hasQualificationRecommendation
  );
}

export function mergeDiscoveryCandidates(
  existing: DiscoveryCandidateInput,
  incoming: DiscoveryCandidateInput
): DiscoveryCandidateInput {
  // Both sides are already stripped of contact/social/coordinate data by
  // normalizeDiscoveryCandidate — nothing left here to merge for those
  // fields (Task #6B).
  const current = normalizeDiscoveryCandidate(existing);
  const next = normalizeDiscoveryCandidate(incoming);
  return {
    ...current,
    websiteUrl: current.websiteUrl || next.websiteUrl,
    languagesDetected: unique([
      ...(current.languagesDetected || []),
      ...(next.languagesDetected || [])
    ]),
    discoverySource: current.discoverySource || next.discoverySource,
    sourceUrls: unique([...current.sourceUrls, ...next.sourceUrls]),
    pilot: Boolean(current.pilot || next.pilot),
    closed: Boolean(current.closed || next.closed)
  };
}

export function evaluateDiscoveryCandidate(
  input: DiscoveryCandidateInput
): DiscoveryDecision {
  const normalized = normalizeDiscoveryCandidate(input);
  const reasons: string[] = [];
  if (!normalized.businessName) reasons.push("Business name is missing.");
  if (!normalized.city) reasons.push("City is missing.");
  if (!ACTIVE_DISCOVERY_COUNTRIES.includes(normalized.country as "MA"))
    reasons.push("Country is outside the currently active discovery market.");
  if (!HOSPITALITY_CATEGORIES.has(normalized.category))
    reasons.push("Business is outside the Morocco hospitality target market.");
  if (normalized.closed)
    reasons.push("Public information marks the business as closed.");
  if (!normalized.sourceUrls.length)
    reasons.push("No valid public source URL is available.");

  // Task #6B: acceptance and confidence must no longer depend on contact
  // data (email/phone/WhatsApp), precise coordinates, or social/booking
  // links — none of that is collected any more (normalizeDiscoveryCandidate
  // always clears it). A business without a website is still acceptable on
  // name + city alone, matching the preferred business-level identity model
  // (see discoveryIdentityKeys); a website plus multiple independent public
  // sources is what raises confidence.
  const accepted = reasons.length === 0;
  const confidence: EvidenceConfidence = !accepted
    ? "Low"
    : normalized.websiteUrl && normalized.sourceUrls.length >= 2
      ? "High"
      : normalized.websiteUrl || normalized.sourceUrls.length >= 2
        ? "Medium"
        : "Low";
  return { accepted, confidence, reasons, normalized };
}

export function discoveryLearningAdjustment(
  stats: DiscoveryLearningStats
): number {
  const total = stats.approved + stats.rejected + stats.ignored;
  if (total < 3) return 0;
  const positiveRate = stats.approved / total;
  return Math.max(-10, Math.min(10, Math.round((positiveRate - 0.5) * 20)));
}

export function calculateDiscoveryPriority(
  input: DiscoveryCandidateInput,
  observations: ObservedIssue[] = [],
  learningAdjustment = 0
): DiscoveryPriority {
  const candidate = normalizeDiscoveryCandidate(input);
  let baseScore = 20;
  const reasons: string[] = ["Valid public Morocco hospitality candidate: +20"];
  const add = (points: number, reason: string) => {
    baseScore += points;
    reasons.push(`${reason}: +${points}`);
  };
  // Task #6B: priority scoring must not depend on contact data or social
  // presence — neither is collected any more (normalizeDiscoveryCandidate).
  if (candidate.websiteUrl) add(10, "Public website can be evaluated");
  else add(15, "No standalone website is recorded");
  const verifiedCodes = new Set(
    observations
      .filter((observation) => observation.verified)
      .map((observation) => observation.code)
  );
  const observedFactors: Array<[string, number, string]> = [
    ["website_unavailable", 18, "Website availability issue verified"],
    ["mobile_viewport", 15, "Mobile usability issue verified"],
    ["menu_missing", 14, "Menu access issue verified"],
    ["reservation_missing", 10, "Booking path issue verified"],
    ["language_missing", 8, "Language support issue verified"],
    ["design_outdated", 8, "Outdated design evidence verified"]
  ];
  for (const [code, points, reason] of observedFactors)
    if (verifiedCodes.has(code)) add(points, reason);
  const safeAdjustment = Math.max(-10, Math.min(10, learningAdjustment));
  if (safeAdjustment)
    reasons.push(
      `Historical review pattern for similar candidates: ${safeAdjustment > 0 ? "+" : ""}${safeAdjustment}`
    );
  return {
    score: Math.max(0, Math.min(100, baseScore + safeAdjustment)),
    baseScore: Math.max(0, Math.min(100, baseScore)),
    learningAdjustment: safeAdjustment,
    reasons
  };
}

export function robotsAllowsDiscovery(
  robots: string,
  pathname: string,
  userAgent = "ReelHaus-Discovery"
): boolean {
  const groups: Array<{
    agents: string[];
    disallow: string[];
    allow: string[];
  }> = [];
  let current:
    | { agents: string[]; disallow: string[]; allow: string[] }
    | undefined;
  let rulesStarted = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || rulesStarted) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
        rulesStarted = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current || (field !== "allow" && field !== "disallow")) continue;
    rulesStarted = true;
    if (value) current[field].push(value);
  }
  const requestedAgent = userAgent.toLowerCase();
  const applicable = groups.filter((group) =>
    group.agents.some(
      (agent) => agent === "*" || requestedAgent.includes(agent)
    )
  );
  const rules = applicable.flatMap((group) => [
    ...group.allow.map((path) => ({ path, allowed: true })),
    ...group.disallow.map((path) => ({ path, allowed: false }))
  ]);
  const matching = rules
    .filter((rule) => pathname.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length);
  return matching[0]?.allowed ?? true;
}

function schemaTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaTypes);
  return typeof value === "string" ? [value] : [];
}

function categoryFromSchema(
  types: string[],
  name: string
): LeadCategory | null {
  if (types.includes("FastFoodRestaurant")) return "snack";
  if (types.includes("Restaurant") || types.includes("FoodEstablishment")) {
    if (/beach\s*club|plage/i.test(name)) return "beach_club";
    if (/rooftop|roof\s*top|terrasse panoramique/i.test(name))
      return "rooftop_restaurant";
    return "restaurant";
  }
  if (types.includes("CafeOrCoffeeShop")) return "cafe";
  if (types.includes("Bakery")) return "bakery";
  if (types.includes("Hotel"))
    return /\briad\b/i.test(name) ? "riad" : "small_hotel";
  if (types.includes("BedAndBreakfast") || types.includes("LodgingBusiness"))
    return /\briad\b/i.test(name) ? "riad" : "small_hotel";
  return null;
}

function categoryFromOsm(tags: Record<string, string>): LeadCategory | null {
  if (tags.shop === "bakery") return "bakery";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "fast_food") return "snack";
  if (tags.amenity === "restaurant") {
    if (/beach\s*club|club\s*de\s*plage/i.test(tags.name || ""))
      return "beach_club";
    if (/rooftop|roof\s*top|terrasse panoramique/i.test(tags.name || ""))
      return "rooftop_restaurant";
    return "restaurant";
  }
  if (["hotel", "guest_house"].includes(tags.tourism || ""))
    return /\briad\b/i.test(tags.name || "") ? "riad" : "small_hotel";
  return null;
}

function osmPublicUrl(tags: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = publicUrl(tags[key]);
    if (value) return value;
  }
  return "";
}

export function moroccoDiscoveryLocation(day = new Date()): (typeof MOROCCO_DISCOVERY_LOCATIONS)[number] {
  const utcDay = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate()
  );
  const index = Math.floor(utcDay / 86_400_000) % MOROCCO_DISCOVERY_LOCATIONS.length;
  return MOROCCO_DISCOVERY_LOCATIONS[index];
}

const DISCOVERY_FOCUSES = [
  'node["name"]["amenity"="cafe"]',
  'node["name"]["shop"="bakery"]',
  'node["name"]["amenity"="fast_food"]',
  'node["name"]["amenity"="restaurant"]',
  'node["name"]["tourism"~"^(hotel|guest_house)$"]'
] as const;

export function moroccoDiscoveryFocus(day = new Date()): string {
  const utcDay = Math.floor(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) /
      86_400_000
  );
  return DISCOVERY_FOCUSES[utcDay % DISCOVERY_FOCUSES.length];
}

function osmHospitalityQuery(
  location: (typeof MOROCCO_DISCOVERY_LOCATIONS)[number],
  day: Date
): string {
  const bbox = `${location.south},${location.west},${location.north},${location.east}`;
  return `[out:json][timeout:15];${moroccoDiscoveryFocus(day)}(${bbox});out qt 20;`;
}

export async function researchOpenStreetMapHospitality(
  day = new Date(),
  fetcher: typeof fetch = fetch
): Promise<PublicSourceResult & { city: string }> {
  const location = moroccoDiscoveryLocation(day);
  let lastFailure = "OpenStreetMap source fetch failed";
  for (const endpoint of OPENSTREETMAP_OVERPASS_ENDPOINTS) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "ReelHaus-Discovery/1.0 public-hospitality-research"
        },
        body: `data=${encodeURIComponent(osmHospitalityQuery(location, day))}`,
        // Task #6B: this is one of two fixed, hardcoded HTTPS endpoints
        // (never candidate-controlled) — "manual" is the safest small fix
        // appropriate here: refuse to blindly follow a redirect rather than
        // building full per-hop revalidation for a URL that never varies.
        // A 3xx response is not `.ok`, so it already falls into the
        // failure branch below.
        redirect: "manual",
        signal: AbortSignal.timeout(endpoint === OPENSTREETMAP_OVERPASS_ENDPOINTS[0] ? 20_000 : 10_000)
      });
      if (!response.ok) {
        lastFailure = `OpenStreetMap source returned HTTP ${response.status}`;
        continue;
      }
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > MAX_OVERPASS_JSON_BYTES) {
        lastFailure = "OpenStreetMap response exceeds the size limit";
        continue;
      }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_OVERPASS_JSON_BYTES) {
        lastFailure = "OpenStreetMap response exceeds the size limit";
        continue;
      }
      const parsed = JSON.parse(raw) as OsmResponse;
      const candidates = (parsed.elements || []).flatMap((element) => {
      const tags = element.tags || {};
      const category = categoryFromOsm(tags);
      const businessName = stringValue(tags.name);
      if (!category || !businessName) return [];
      const sourceUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;
      // Task #6B: only the business's own website is a public-review
      // signal Discovery keeps. contact:email/phone/whatsapp and social/
      // booking links are deliberately never read into the candidate,
      // even when OSM publishes them — not just stripped later.
      const websiteUrl = osmPublicUrl(tags, "contact:website", "website", "url");
      const languagesDetected = [
        tags["name:fr"] ? "fr" : "",
        tags["name:ar"] ? "ar" : ""
      ].filter(Boolean);
      return [
        {
          businessName,
          category,
          city: stringValue(tags["addr:city"]) || location.city,
          country: "MA",
          websiteUrl: websiteUrl || undefined,
          languagesDetected,
          discoverySource: sourceUrl,
          sourceUrls: [sourceUrl],
          language:
            tags["name:ar"] && !tags["name:fr"] ? ("ar" as const) : ("fr" as const)
        }
      ];
      });
      return { sourceUrl: endpoint, city: location.city, candidates };
    } catch (error) {
      lastFailure =
        error instanceof Error ? error.message : "OpenStreetMap source fetch failed";
    }
  }
  return {
    sourceUrl: OPENSTREETMAP_OVERPASS_ENDPOINTS[0],
    city: location.city,
    candidates: [],
    skippedReason: lastFailure
  };
}

function wikidataFocus(day: Date): { entity: string; category: LeadCategory } {
  const focus = moroccoDiscoveryFocus(day);
  if (focus.includes('"cafe"')) return { entity: "Q30022", category: "cafe" };
  if (focus.includes('"bakery"'))
    return { entity: "Q274393", category: "bakery" };
  if (focus.includes('"hotel|guest_house"'))
    return { entity: "Q27686", category: "small_hotel" };
  if (focus.includes('"fast_food"'))
    return { entity: "Q11707", category: "snack" };
  return { entity: "Q11707", category: "restaurant" };
}

function wikidataHospitalityQuery(day: Date): string {
  const focus = wikidataFocus(day);
  return `SELECT ?item ?itemLabel ?website ?coord ?locationLabel WHERE {
    ?item wdt:P31 wd:${focus.entity}; wdt:P17 wd:Q1028; wdt:P131 ?location.
    OPTIONAL { ?item wdt:P856 ?website. }
    OPTIONAL { ?item wdt:P625 ?coord. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,ar,en". }
  } LIMIT 20`;
}

export async function researchWikidataHospitality(
  day = new Date(),
  fetcher: typeof fetch = fetch
): Promise<PublicSourceResult> {
  const endpoint = new URL("https://query.wikidata.org/sparql");
  endpoint.searchParams.set("query", wikidataHospitalityQuery(day));
  const focus = wikidataFocus(day);
  try {
    const response = await fetcher(endpoint, {
      headers: {
        accept: "application/sparql-results+json",
        "user-agent": "ReelHaus-Discovery/1.0 (https://reelhaus.de)",
        "api-user-agent": "ReelHaus-Discovery/1.0 (https://reelhaus.de)"
      },
      // Task #6B: fixed HTTPS endpoint, never candidate-controlled — refuse
      // to blindly follow a redirect (see the matching comment above in
      // researchOpenStreetMapHospitality).
      redirect: "manual",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok)
      return {
        sourceUrl: endpoint.origin,
        candidates: [],
        skippedReason: `Wikidata source returned HTTP ${response.status}`
      };
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_OVERPASS_JSON_BYTES)
      return {
        sourceUrl: endpoint.origin,
        candidates: [],
        skippedReason: "Wikidata response exceeds the size limit"
      };
    const parsed = JSON.parse(raw) as WikidataResponse;
    const candidates = (parsed.results?.bindings || []).flatMap((binding) => {
      const item = binding.item?.value || "";
      const businessName = binding.itemLabel?.value?.trim() || "";
      const city = binding.locationLabel?.value?.trim() || "";
      const itemId = item.match(/Q\d+$/)?.[0];
      if (!itemId || !businessName || !city) return [];
      const coordinate = (binding.coord?.value || "").match(
        /^Point\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/
      );
      const longitude = coordinate ? Number(coordinate[1]) : undefined;
      const latitude = coordinate ? Number(coordinate[2]) : undefined;
      const sourceUrl = `https://www.wikidata.org/wiki/${itemId}`;
      const mapsUrl =
        latitude !== undefined && longitude !== undefined
          ? `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`
          : undefined;
      const category =
        focus.category === "small_hotel" && /\briad\b/i.test(businessName)
          ? "riad"
          : focus.category;
      return [
        {
          businessName,
          category,
          city,
          country: "MA",
          websiteUrl: publicUrl(binding.website?.value) || undefined,
          mapsUrl,
          languagesDetected: binding.itemLabel?.["xml:lang"]
            ? [binding.itemLabel["xml:lang"]!]
            : [],
          latitude,
          longitude,
          discoverySource: sourceUrl,
          sourceUrls: [sourceUrl],
          language:
            binding.itemLabel?.["xml:lang"] === "ar"
              ? ("ar" as const)
              : ("fr" as const)
        }
      ];
    });
    return { sourceUrl: endpoint.origin, candidates };
  } catch (error) {
    return {
      sourceUrl: endpoint.origin,
      candidates: [],
      skippedReason:
        error instanceof Error ? error.message : "Wikidata source fetch failed"
    };
  }
}

function objectsFromJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objectsFromJsonLd);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const graph = objectsFromJsonLd(object["@graph"]);
  return [object, ...graph];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : stringValue(value)
      ? [stringValue(value)]
      : [];
}

function countryIsMorocco(value: unknown): boolean {
  const country =
    typeof value === "object" && value
      ? stringValue((value as Record<string, unknown>).name)
      : stringValue(value);
  return /^(ma|maroc|morocco|المغرب)$/i.test(country);
}

export function extractPublicDirectoryCandidates(
  html: string,
  sourceUrl: string
): DiscoveryCandidateInput[] {
  const candidates: DiscoveryCandidateInput[] = [];
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[1]);
    } catch {
      continue;
    }
    for (const object of objectsFromJsonLd(parsed)) {
      const name = stringValue(object.name);
      const category = categoryFromSchema(schemaTypes(object["@type"]), name);
      const address =
        object.address && typeof object.address === "object"
          ? (object.address as Record<string, unknown>)
          : {};
      if (!category || !name || !countryIsMorocco(address.addressCountry))
        continue;
      // Task #6B: only the business's own website is kept as a public-
      // review signal. email/telephone, sameAs (social) links, booking
      // links, and geo coordinates are deliberately never read into the
      // candidate, even when the source's JSON-LD publishes them.
      const languagesDetected = unique([
        ...stringArray(object.inLanguage),
        ...stringArray(object.availableLanguage)
      ]);
      candidates.push({
        businessName: name,
        category,
        city: stringValue(address.addressLocality),
        country: "MA",
        websiteUrl: publicUrl(stringValue(object.url)) || undefined,
        languagesDetected,
        sourceUrls: [sourceUrl],
        discoverySource: sourceUrl,
        language: "fr",
        closed:
          /closed|permanently closed|fermé définitivement|مغلق نهائيا/i.test(
            stringValue(object.businessStatus)
          )
      });
    }
  }
  return candidates;
}

// Task #6B: candidate-controlled/configured source URLs are variable, so
// they go through the existing hardened, redirect-safe fetcher
// (safe-fetch.ts) instead of a raw fetch() — every hop, including the
// robots.txt lookup, is re-validated by url-safety.ts, not just the initial
// URL as typed.
export async function researchPublicSource(
  sourceUrl: string,
  fetcher: typeof fetch = fetch
): Promise<PublicSourceResult> {
  const validation = validatePublicScanUrl(sourceUrl);
  if (!validation.ok)
    return {
      sourceUrl,
      candidates: [],
      skippedReason: `Invalid public URL: ${validation.reason}`
    };
  const normalizedSource = validation.url;
  const url = new URL(normalizedSource);
  const fetchOptions = {
    totalTimeoutMs: 12_000,
    userAgent: "ReelHaus-Discovery/1.0 public-hospitality-research"
  } as const;

  const robotsResult = await safeFetchPublicUrl(
    fetcher,
    new URL("/robots.txt", url).toString(),
    {
      ...fetchOptions,
      totalTimeoutMs: 8_000,
      // robots.txt is conventionally text/plain, not HTML — the default
      // allowlist (html only) would wrongly reject a standards-compliant
      // robots.txt response.
      allowedContentTypes: ["text/plain", "text/html", "application/xhtml+xml"]
    }
  );
  if (!robotsResult.ok && robotsResult.reason === "http_401")
    return {
      sourceUrl: normalizedSource,
      candidates: [],
      skippedReason: "robots.txt is not publicly accessible"
    };
  if (!robotsResult.ok && robotsResult.reason === "http_403")
    return {
      sourceUrl: normalizedSource,
      candidates: [],
      skippedReason: "robots.txt is not publicly accessible"
    };
  // Any other robots.txt outcome (missing, timed out, wrong content type,
  // etc.) is treated as "no robots.txt to enforce" — matching the prior
  // behavior, which only ever blocked on a fetched, parseable robots.txt.
  if (
    robotsResult.ok &&
    !robotsAllowsDiscovery(robotsResult.html, url.pathname)
  )
    return {
      sourceUrl: normalizedSource,
      candidates: [],
      skippedReason: "robots.txt disallows this source"
    };

  const pageResult = await safeFetchPublicUrl(fetcher, normalizedSource, {
    ...fetchOptions,
    maxContentBytes: MAX_SOURCE_HTML_BYTES
  });
  if (!pageResult.ok)
    return {
      sourceUrl: normalizedSource,
      candidates: [],
      skippedReason: `Source fetch failed: ${pageResult.reason}`
    };
  return {
    sourceUrl: pageResult.finalUrl,
    candidates: extractPublicDirectoryCandidates(
      pageResult.html,
      pageResult.finalUrl
    )
  };
}
