import { describe, expect, it, vi } from "vitest";
import {
  AUTONOMOUS_DISCOVERY_VERSION,
  calculateDiscoveryPriority,
  discoveryCandidateCanBeApproved,
  discoveryCandidateIsCrmVisible,
  discoveryDedupeKey,
  discoveryLeadDedupeKey,
  discoveryIdentityKeys,
  discoveryLearningAdjustment,
  evaluateDiscoveryCandidate,
  extractPublicDirectoryCandidates,
  moroccoDiscoveryFocus,
  moroccoDiscoveryLocation,
  mergeDiscoveryCandidates,
  researchOpenStreetMapHospitality,
  researchPublicSource,
  researchWikidataHospitality,
  robotsAllowsDiscovery
} from "./discovery-agent";
import type { DiscoveryCandidateInput } from "./sales-types";

const restaurant: DiscoveryCandidateInput = {
  businessName: "Café Atlas",
  category: "cafe",
  city: "Marrakech",
  country: "MA",
  websiteUrl: "https://www.cafe-atlas.ma/",
  sourceUrls: ["https://directory.example/atlas"]
};

describe("ReelHaus Autonomous Discovery Agent v1.0", () => {
  it("merges duplicate businesses instead of creating a second identity", () => {
    const duplicate = {
      ...restaurant,
      websiteUrl: "https://cafe-atlas.ma/menu",
      phone: "+212500000000",
      sourceUrls: ["https://another.example/cafe-atlas"]
    };
    expect(discoveryDedupeKey(restaurant)).toBe(discoveryDedupeKey(duplicate));
    expect(mergeDiscoveryCandidates(restaurant, duplicate)).toMatchObject({
      phone: "+212500000000",
      sourceUrls: [
        "https://directory.example/atlas",
        "https://another.example/cafe-atlas"
      ]
    });
  });

  it("deduplicates by website, phone, coordinates and normalized name", () => {
    expect(
      discoveryIdentityKeys({
        ...restaurant,
        phone: "+212 5 00 00 00 00",
        latitude: 31.629472,
        longitude: -7.981084
      })
    ).toEqual(
      expect.arrayContaining([
        "website:cafe-atlas.ma",
        "phone:212500000000",
        "coordinates:31.62947,-7.98108",
        "name-city:cafe atlas|marrakech"
      ])
    );
  });

  it("uses the CRM lead identity before creating a Discovery candidate", () => {
    expect(discoveryLeadDedupeKey(restaurant)).toBe("website:cafe-atlas.ma");
    expect(
      discoveryLeadDedupeKey({
        ...restaurant,
        websiteUrl: "https://cafe-atlas.ma/menu?language=fr"
      })
    ).toBe("website:cafe-atlas.ma");
    expect(
      discoveryLeadDedupeKey({
        ...restaurant,
        websiteUrl: undefined,
        publicEmail: "INFO@CAFE-ATLAS.MA"
      })
    ).toBe("email:info@cafe-atlas.ma");
  });

  it("saves a restaurant with a public website as a candidate only", () => {
    const decision = evaluateDiscoveryCandidate(restaurant);
    expect(AUTONOMOUS_DISCOVERY_VERSION).toBe("1.0");
    expect(decision.accepted).toBe(true);
    expect(decision.confidence).toBe("Medium");
  });

  it.each(["beach_club", "rooftop_restaurant"] as const)(
    "accepts the %s hospitality category",
    (category) => {
      expect(
        evaluateDiscoveryCandidate({ ...restaurant, category }).accepted
      ).toBe(true);
    }
  );

  it("uses priority only for review and explains verified signals", () => {
    const priority = calculateDiscoveryPriority(restaurant, [
      {
        code: "menu_missing",
        detail: "No menu link found",
        sourceUrl: restaurant.websiteUrl || "",
        observedAt: "2026-07-31T00:00:00.000Z",
        verified: true,
        points: 0
      }
    ]);
    expect(priority.score).toBe(44);
    expect(priority.reasons).toContain("Menu access issue verified: +14");
    expect(priority).not.toHaveProperty("qualificationScore");
  });

  it("learns conservatively only after repeated manual decisions", () => {
    expect(
      discoveryLearningAdjustment({ approved: 2, rejected: 0, ignored: 0 })
    ).toBe(0);
    expect(
      discoveryLearningAdjustment({ approved: 4, rejected: 0, ignored: 0 })
    ).toBe(10);
    expect(
      discoveryLearningAdjustment({ approved: 0, rejected: 3, ignored: 1 })
    ).toBe(-10);
  });

  it("keeps scanned candidates out of CRM until manual approval", () => {
    expect(discoveryCandidateIsCrmVisible("new")).toBe(false);
    expect(discoveryCandidateIsCrmVisible("scanned")).toBe(false);
    expect(discoveryCandidateIsCrmVisible("approved")).toBe(true);
    expect(
      discoveryCandidateCanBeApproved(
        { status: "scanned", leadId: "lead-1" },
        true
      )
    ).toBe(true);
    expect(
      discoveryCandidateCanBeApproved({ status: "new", leadId: null }, false)
    ).toBe(false);
  });

  it("rejects a non-hospitality business", () => {
    const decision = evaluateDiscoveryCandidate({
      ...restaurant,
      businessName: "Atlas Consulting",
      category: "local_business"
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain(
      "Business is outside the Morocco hospitality target market."
    );
  });

  it("saves a candidate without email but cannot invent outreach data", () => {
    const decision = evaluateDiscoveryCandidate({
      ...restaurant,
      publicEmail: undefined
    });
    expect(decision.accepted).toBe(true);
    expect(decision.normalized.publicEmail).toBeUndefined();
  });

  it("accepts a business without a website only with enough public signals", () => {
    const sufficient = evaluateDiscoveryCandidate({
      ...restaurant,
      websiteUrl: undefined,
      mapsUrl: "https://maps.google.com/?q=cafe-atlas",
      phone: "+212500000000"
    });
    const insufficient = evaluateDiscoveryCandidate({
      ...restaurant,
      websiteUrl: undefined,
      mapsUrl: "https://maps.google.com/?q=cafe-atlas",
      phone: undefined
    });
    expect(sufficient.accepted).toBe(true);
    expect(insufficient.accepted).toBe(false);
    expect(insufficient.confidence).toBe("Low");
    expect(
      evaluateDiscoveryCandidate({
        ...restaurant,
        websiteUrl: undefined,
        mapsUrl: "https://www.openstreetmap.org/?mlat=31.63&mlon=-7.98",
        phone: undefined,
        latitude: 31.63,
        longitude: -7.98
      }).accepted
    ).toBe(true);
  });

  it("rejects a business explicitly marked closed", () => {
    const decision = evaluateDiscoveryCandidate({
      ...restaurant,
      closed: true
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain(
      "Public information marks the business as closed."
    );
  });

  it("extracts only Morocco hospitality JSON-LD without guessing missing data", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Restaurant",
          name: "Dar Test",
          url: "https://dar-test.ma",
          telephone: "+212500000001",
          address: {
            addressLocality: "Rabat",
            addressCountry: "MA"
          }
        },
        {
          "@type": "Store",
          name: "Not Hospitality",
          address: {
            addressLocality: "Rabat",
            addressCountry: "MA"
          }
        }
      ]
    })}</script>`;
    const candidates = extractPublicDirectoryCandidates(
      html,
      "https://directory.example/rabat"
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      businessName: "Dar Test",
      category: "restaurant",
      city: "Rabat",
      publicEmail: undefined
    });
  });

  it("respects robots.txt and does not fetch a disallowed source page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("User-agent: *\nDisallow: /directory", { status: 200 })
      );
    const result = await researchPublicSource(
      "https://directory.example/directory",
      fetcher as typeof fetch
    );
    expect(
      robotsAllowsDiscovery("User-agent: *\nDisallow: /private", "/private")
    ).toBe(false);
    expect(result.skippedReason).toBe("robots.txt disallows this source");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rotates the bounded Morocco research location by UTC day", () => {
    const first = moroccoDiscoveryLocation(new Date("2026-08-13T10:00:00Z"));
    const next = moroccoDiscoveryLocation(new Date("2026-08-14T10:00:00Z"));
    expect(first.city).not.toBe(next.city);
    expect(moroccoDiscoveryFocus(new Date("2026-08-13T10:00:00Z"))).toContain(
      '"restaurant"'
    );
  });

  it("maps public OpenStreetMap hospitality data without inventing contact data", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 42,
              lat: 31.63,
              lon: -7.98,
              tags: {
                name: "Riad Public Test",
                tourism: "guest_house",
                website: "https://riad-public-test.example/",
                "name:ar": "رياض الاختبار"
              }
            },
            {
              type: "node",
              id: 43,
              tags: { name: "Unrelated Shop", shop: "clothes" }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const result = await researchOpenStreetMapHospitality(
      new Date("2026-08-13T10:00:00Z"),
      fetcher as typeof fetch
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("data=");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      businessName: "Riad Public Test",
      category: "riad",
      country: "MA",
      mapsUrl: "https://www.openstreetmap.org/node/42",
      publicEmail: undefined,
      phone: undefined,
      languagesDetected: ["ar"]
    });
  });

  it("fails safely when the public discovery source is unavailable", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("busy", { status: 429 }));
    const result = await researchOpenStreetMapHospitality(
      new Date("2026-08-13T10:00:00Z"),
      fetcher as typeof fetch
    );
    expect(result.candidates).toEqual([]);
    expect(result.skippedReason).toContain("HTTP 429");
  });

  it("uses the second official public instance when the first is unavailable", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 504 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ elements: [] }), { status: 200 })
      );
    const result = await researchOpenStreetMapHospitality(
      new Date("2026-08-13T10:00:00Z"),
      fetcher as typeof fetch
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.skippedReason).toBeUndefined();
    expect(result.sourceUrl).toContain("overpass-api.de");
  });

  it("maps Wikidata restaurant evidence with a public city and source", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                item: { value: "http://www.wikidata.org/entity/Q5857561" },
                itemLabel: { value: "Rick's Café", "xml:lang": "fr" },
                website: { value: "http://www.rickscafe.ma/" },
                coord: { value: "Point(-7.62037 33.60523)" },
                locationLabel: { value: "Casablanca", "xml:lang": "fr" }
              }
            ]
          }
        })
      )
    );
    const result = await researchWikidataHospitality(
      new Date("2026-08-13T10:00:00Z"),
      fetcher as typeof fetch
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      businessName: "Rick's Café",
      category: "restaurant",
      city: "Casablanca",
      websiteUrl: "http://www.rickscafe.ma/",
      latitude: 33.60523,
      longitude: -7.62037,
      sourceUrls: ["https://www.wikidata.org/wiki/Q5857561"]
    });
  });
});
