import { leadDedupeKey, normalizeEmail, normalizeUrl } from "./sales-policy";
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

function normalizedPhone(value?: string): string {
  const digits = (value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : "";
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

function validCoordinate(
  value: number | undefined,
  limit: number
): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit
    ? Number(value.toFixed(6))
    : undefined;
}

export function normalizeDiscoveryCandidate(
  input: DiscoveryCandidateInput
): DiscoveryCandidateInput {
  return {
    ...input,
    businessName: input.businessName?.trim() || "",
    city: input.city?.trim() || "",
    country: (input.country || "MA").trim().toUpperCase(),
    websiteUrl: publicUrl(input.websiteUrl) || undefined,
    mapsUrl: publicUrl(input.mapsUrl) || undefined,
    publicEmail: normalizeEmail(input.publicEmail) || undefined,
    phone: input.phone?.trim() || undefined,
    whatsapp: input.whatsapp?.trim() || undefined,
    socialLinks: unique(input.socialLinks || [])
      .map(publicUrl)
      .filter(Boolean),
    bookingLinks: unique(input.bookingLinks || [])
      .map(publicUrl)
      .filter(Boolean),
    languagesDetected: unique(input.languagesDetected || []).map((language) =>
      language.toLocaleLowerCase()
    ),
    latitude: validCoordinate(input.latitude, 90),
    longitude: validCoordinate(input.longitude, 180),
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

export function discoveryIdentityKeys(
  input: DiscoveryCandidateInput
): string[] {
  const normalized = normalizeDiscoveryCandidate(input);
  const keys: string[] = [];
  if (normalized.websiteUrl)
    keys.push(
      `website:${new URL(normalized.websiteUrl).hostname.replace(/^www\./, "")}`
    );
  const phone = normalizedPhone(normalized.phone);
  if (phone) keys.push(`phone:${phone}`);
  if (normalized.latitude !== undefined && normalized.longitude !== undefined)
    keys.push(
      `coordinates:${normalized.latitude.toFixed(5)},${normalized.longitude.toFixed(5)}`
    );
  if (normalized.mapsUrl) keys.push(`maps:${normalized.mapsUrl}`);
  keys.push(
    `name-city:${normalizedName(normalized.businessName)}|${normalizedName(normalized.city)}`
  );
  return [...new Set(keys.filter((key) => !key.endsWith(":")))];
}

export function discoveryDedupeKey(input: DiscoveryCandidateInput): string {
  return discoveryIdentityKeys(input)[0] || "invalid:unknown";
}

export function discoveryLeadDedupeKey(input: DiscoveryCandidateInput): string {
  const normalized = normalizeDiscoveryCandidate(input);
  return leadDedupeKey({
    businessName: normalized.businessName,
    category: normalized.category,
    city: normalized.city,
    country: "MA",
    websiteUrl: normalized.websiteUrl,
    mapsUrl: normalized.mapsUrl,
    publicEmail: normalized.publicEmail,
    phone: normalized.phone,
    whatsapp: normalized.whatsapp,
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
  const current = normalizeDiscoveryCandidate(existing);
  const next = normalizeDiscoveryCandidate(incoming);
  return {
    ...current,
    websiteUrl: current.websiteUrl || next.websiteUrl,
    mapsUrl: current.mapsUrl || next.mapsUrl,
    publicEmail: current.publicEmail || next.publicEmail,
    phone: current.phone || next.phone,
    whatsapp: current.whatsapp || next.whatsapp,
    socialLinks: unique([
      ...(current.socialLinks || []),
      ...(next.socialLinks || [])
    ]),
    bookingLinks: unique([
      ...(current.bookingLinks || []),
      ...(next.bookingLinks || [])
    ]),
    languagesDetected: unique([
      ...(current.languagesDetected || []),
      ...(next.languagesDetected || [])
    ]),
    latitude: current.latitude ?? next.latitude,
    longitude: current.longitude ?? next.longitude,
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

  const directContactSignals = [
    normalized.publicEmail,
    normalized.phone,
    normalized.whatsapp
  ].filter(Boolean).length;
  const linkedSignals =
    (normalized.socialLinks?.length || 0) +
    (normalized.bookingLinks?.length || 0);
  const identitySignals = [
    normalized.websiteUrl,
    normalized.mapsUrl,
    normalized.latitude !== undefined && normalized.longitude !== undefined
      ? "coordinates"
      : "",
    directContactSignals ? "contact" : "",
    linkedSignals ? "public-link" : ""
  ].filter(Boolean).length;
  if (!normalized.websiteUrl && identitySignals < 2)
    reasons.push(
      "A candidate without a website needs at least two independent public identity or contact signals."
    );

  const accepted = reasons.length === 0;
  const confidence: EvidenceConfidence = !accepted
    ? "Low"
    : normalized.sourceUrls.length >= 2 && identitySignals >= 2
      ? "High"
      : identitySignals >= 1
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
  if (candidate.websiteUrl) add(10, "Public website can be evaluated");
  else add(15, "No standalone website is recorded");
  if (candidate.socialLinks?.length)
    add(6, "Public social presence is recorded");
  if (candidate.publicEmail || candidate.phone || candidate.whatsapp)
    add(4, "Public business contact is recorded");
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
      const websiteUrl = osmPublicUrl(tags, "contact:website", "website", "url");
      const socialLinks = unique([
        osmPublicUrl(tags, "contact:instagram", "instagram"),
        osmPublicUrl(tags, "contact:facebook", "facebook"),
        osmPublicUrl(tags, "contact:tiktok", "tiktok")
      ]);
      const bookingLinks = unique([
        osmPublicUrl(tags, "reservation:website", "booking", "contact:booking")
      ]);
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
          mapsUrl: sourceUrl,
          publicEmail:
            stringValue(tags["contact:email"]) ||
            stringValue(tags.email) ||
            undefined,
          phone:
            stringValue(tags["contact:phone"]) ||
            stringValue(tags.phone) ||
            undefined,
          whatsapp:
            stringValue(tags["contact:whatsapp"]) ||
            stringValue(tags.whatsapp) ||
            undefined,
          socialLinks,
          bookingLinks,
          languagesDetected,
          latitude: element.lat ?? element.center?.lat,
          longitude: element.lon ?? element.center?.lon,
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

function bookingTargets(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(bookingTargets);
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [
    stringValue(object.url),
    stringValue(object.urlTemplate),
    ...bookingTargets(object.target)
  ].filter(Boolean);
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
      const socialLinks = stringArray(object.sameAs)
        .map(publicUrl)
        .filter(Boolean);
      const mapsUrl = socialLinks.find((url) =>
        /google\.[^/]+\/maps|maps\.app\.goo\.gl/i.test(url)
      );
      const bookingLinks = bookingTargets(object.potentialAction)
        .map(publicUrl)
        .filter(Boolean);
      const geo =
        object.geo && typeof object.geo === "object"
          ? (object.geo as Record<string, unknown>)
          : {};
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
        mapsUrl,
        publicEmail: stringValue(object.email) || undefined,
        phone: stringValue(object.telephone) || undefined,
        socialLinks,
        bookingLinks,
        languagesDetected,
        latitude: Number(stringValue(geo.latitude)) || undefined,
        longitude: Number(stringValue(geo.longitude)) || undefined,
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

export async function researchPublicSource(
  sourceUrl: string,
  fetcher: typeof fetch = fetch
): Promise<PublicSourceResult> {
  const normalizedSource = publicUrl(sourceUrl);
  if (!normalizedSource)
    return { sourceUrl, candidates: [], skippedReason: "Invalid public URL" };
  const url = new URL(normalizedSource);
  const headers = {
    accept: "text/html,application/xhtml+xml",
    "user-agent": "ReelHaus-Discovery/1.0 public-hospitality-research"
  };
  try {
    const robotsResponse = await fetcher(new URL("/robots.txt", url), {
      headers,
      signal: AbortSignal.timeout(8_000)
    });
    if (robotsResponse.status === 401 || robotsResponse.status === 403)
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: "robots.txt is not publicly accessible"
      };
    if (
      robotsResponse.ok &&
      !robotsAllowsDiscovery(await robotsResponse.text(), url.pathname)
    )
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: "robots.txt disallows this source"
      };
    const response = await fetcher(normalizedSource, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok)
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: `Source returned HTTP ${response.status}`
      };
    if (
      !(response.headers.get("content-type") || "")
        .toLowerCase()
        .includes("text/html")
    )
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: "Source is not HTML"
      };
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_SOURCE_HTML_BYTES)
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: "Source exceeds the size limit"
      };
    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > MAX_SOURCE_HTML_BYTES)
      return {
        sourceUrl: normalizedSource,
        candidates: [],
        skippedReason: "Source exceeds the size limit"
      };
    return {
      sourceUrl: normalizedSource,
      candidates: extractPublicDirectoryCandidates(html, normalizedSource)
    };
  } catch (error) {
    return {
      sourceUrl: normalizedSource,
      candidates: [],
      skippedReason:
        error instanceof Error ? error.message : "Public source fetch failed"
    };
  }
}
