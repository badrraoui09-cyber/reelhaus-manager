import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  normalizeDiscoveryCandidate,
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
  it("merges duplicate businesses instead of creating a second identity, without persisting contact data", () => {
    const duplicate = {
      ...restaurant,
      websiteUrl: "https://cafe-atlas.ma/menu",
      phone: "+212500000000",
      sourceUrls: ["https://another.example/cafe-atlas"]
    };
    expect(discoveryDedupeKey(restaurant)).toBe(discoveryDedupeKey(duplicate));
    const merged = mergeDiscoveryCandidates(restaurant, duplicate);
    expect(merged.phone).toBeUndefined();
    expect(merged.sourceUrls).toEqual([
      "https://directory.example/atlas",
      "https://another.example/cafe-atlas"
    ]);
  });

  it("prefers website hostname for identity, ignoring phone and coordinates entirely", () => {
    expect(
      discoveryIdentityKeys({
        ...restaurant,
        phone: "+212 5 00 00 00 00",
        latitude: 31.629472,
        longitude: -7.981084
      })
    ).toEqual(["website:cafe-atlas.ma"]);
  });

  it("falls back to business name + city when no website is present, ignoring phone/coordinates", () => {
    const withoutWebsite = { ...restaurant, websiteUrl: undefined };
    expect(discoveryIdentityKeys(withoutWebsite)).toEqual([
      "name-city:cafe atlas|marrakech"
    ]);
    // Adding phone/coordinates must not change the identity key — dedupe no
    // longer depends on contact data or precise location (Task #6B).
    expect(
      discoveryIdentityKeys({
        ...withoutWebsite,
        phone: "+212500000000",
        latitude: 31.63,
        longitude: -7.98
      })
    ).toEqual(["name-city:cafe atlas|marrakech"]);
  });

  it("uses the CRM lead identity before creating a Discovery candidate, without matching on email", () => {
    expect(discoveryLeadDedupeKey(restaurant)).toBe("website:cafe-atlas.ma");
    expect(
      discoveryLeadDedupeKey({
        ...restaurant,
        websiteUrl: "https://cafe-atlas.ma/menu?language=fr"
      })
    ).toBe("website:cafe-atlas.ma");
    // Task #6B: a public email is no longer collected/passed through, so a
    // website-less candidate falls straight to name+city, never email.
    expect(
      discoveryLeadDedupeKey({
        ...restaurant,
        websiteUrl: undefined,
        publicEmail: "INFO@CAFE-ATLAS.MA"
      })
    ).toBe("name-city:café atlas|marrakech");
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

  it("uses priority only for review and explains verified signals, without a contact-based bonus", () => {
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
    expect(priority.reasons.join(" ")).not.toContain("contact");
    expect(priority).not.toHaveProperty("qualificationScore");
  });

  it("priority scoring is identical whether or not a source provides contact/social data", () => {
    const withoutSignals = calculateDiscoveryPriority(restaurant);
    const withSignals = calculateDiscoveryPriority({
      ...restaurant,
      publicEmail: "info@cafe-atlas.ma",
      phone: "+212500000000",
      whatsapp: "+212500000000",
      socialLinks: ["https://instagram.com/cafeatlas"]
    });
    expect(withSignals.score).toBe(withoutSignals.score);
    expect(withSignals.reasons).toEqual(withoutSignals.reasons);
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

  it("accepts a business without a website on business name + city alone (no contact/social signal required)", () => {
    const withoutWebsite = evaluateDiscoveryCandidate({
      ...restaurant,
      websiteUrl: undefined
    });
    expect(withoutWebsite.accepted).toBe(true);
    expect(withoutWebsite.confidence).toBe("Low");
    // Task #6B: contact/social/coordinate data must not change the accept
    // decision or confidence for a website-less candidate — it's ignored.
    const withIgnoredSignals = evaluateDiscoveryCandidate({
      ...restaurant,
      websiteUrl: undefined,
      phone: "+212500000000",
      publicEmail: "info@cafe-atlas.ma",
      socialLinks: ["https://instagram.com/cafeatlas"],
      latitude: 31.63,
      longitude: -7.98
    });
    expect(withIgnoredSignals.accepted).toBe(true);
    expect(withIgnoredSignals.confidence).toBe("Low");
  });

  it("still rejects a website-less candidate missing business name or city", () => {
    expect(
      evaluateDiscoveryCandidate({
        ...restaurant,
        websiteUrl: undefined,
        businessName: ""
      }).accepted
    ).toBe(false);
    expect(
      evaluateDiscoveryCandidate({
        ...restaurant,
        websiteUrl: undefined,
        city: ""
      }).accepted
    ).toBe(false);
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

  it("Discovery writes never persist contact fields, exact coordinates, or social/booking arrays — even when a source provides them", () => {
    const withEverything: DiscoveryCandidateInput = {
      ...restaurant,
      publicEmail: "owner@cafe-atlas.ma",
      phone: "+212500000000",
      whatsapp: "+212500000001",
      socialLinks: ["https://instagram.com/cafeatlas"],
      bookingLinks: ["https://booking.example/cafe-atlas"],
      mapsUrl: "https://maps.google.com/?q=cafe-atlas",
      latitude: 31.629472,
      longitude: -7.981084
    };
    const normalized = normalizeDiscoveryCandidate(withEverything);
    expect(normalized.publicEmail).toBeUndefined();
    expect(normalized.phone).toBeUndefined();
    expect(normalized.whatsapp).toBeUndefined();
    expect(normalized.mapsUrl).toBeUndefined();
    expect(normalized.latitude).toBeUndefined();
    expect(normalized.longitude).toBeUndefined();
    expect(normalized.socialLinks).toEqual([]);
    expect(normalized.bookingLinks).toEqual([]);
    // The business-level fields that ARE part of the privacy-minimized v1
    // data model must still survive normalization untouched.
    expect(normalized.businessName).toBe("Café Atlas");
    expect(normalized.city).toBe("Marrakech");
    expect(normalized.websiteUrl).toBe("https://www.cafe-atlas.ma/");
  });

  it("extracts only Morocco hospitality JSON-LD, ignoring email/telephone/sameAs/geo even when present", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Restaurant",
          name: "Dar Test",
          url: "https://dar-test.ma",
          telephone: "+212500000001",
          email: "owner@dar-test.ma",
          sameAs: ["https://instagram.com/dartest", "https://maps.google.com/?q=dar-test"],
          geo: { latitude: "34.02", longitude: "-6.83" },
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
      websiteUrl: "https://dar-test.ma/"
    });
    expect(candidates[0]).not.toHaveProperty("publicEmail");
    expect(candidates[0]).not.toHaveProperty("phone");
    expect(candidates[0]).not.toHaveProperty("socialLinks");
    expect(candidates[0]).not.toHaveProperty("bookingLinks");
    expect(candidates[0]).not.toHaveProperty("mapsUrl");
    expect(candidates[0]).not.toHaveProperty("latitude");
    expect(candidates[0]).not.toHaveProperty("longitude");
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

  it("rejects a private/internal candidate-source URL before ever fetching it (SSRF guard)", async () => {
    const fetcher = vi.fn();
    const result = await researchPublicSource(
      "https://169.254.169.254/latest/meta-data/",
      fetcher as unknown as typeof fetch
    );
    expect(result.skippedReason).toContain("Invalid public URL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not blindly follow a redirect for a candidate-controlled source (hardened redirect-safe fetch)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("User-agent: *", {
          status: 200,
          headers: { "content-type": "text/plain" }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/steal-me" }
        })
      );
    const result = await researchPublicSource(
      "https://directory.example/redirecting-page",
      fetcher as typeof fetch
    );
    expect(result.candidates).toEqual([]);
    expect(result.skippedReason).toContain("Source fetch failed");
    // Confirms it never fell through to a second, unsafe hop.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rotates the bounded Morocco research location by UTC day", () => {
    const first = moroccoDiscoveryLocation(new Date("2026-08-13T10:00:00Z"));
    const next = moroccoDiscoveryLocation(new Date("2026-08-14T10:00:00Z"));
    expect(first.city).not.toBe(next.city);
    expect(moroccoDiscoveryFocus(new Date("2026-08-13T10:00:00Z"))).toContain(
      '"restaurant"'
    );
  });

  it("maps public OpenStreetMap hospitality data, ignoring email/phone/WhatsApp/social/booking/coordinates even when OSM publishes them", async () => {
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
                "contact:email": "owner@riad-public-test.example",
                "contact:phone": "+212500000002",
                "contact:whatsapp": "+212500000003",
                "contact:instagram": "https://instagram.com/riadpublictest",
                "reservation:website": "https://booking.example/riad",
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
    // Task #6B: a fixed OSM endpoint must not blindly follow a redirect.
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("data=");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      businessName: "Riad Public Test",
      category: "riad",
      country: "MA",
      websiteUrl: "https://riad-public-test.example/",
      languagesDetected: ["ar"]
    });
    expect(result.candidates[0]).not.toHaveProperty("publicEmail");
    expect(result.candidates[0]).not.toHaveProperty("phone");
    expect(result.candidates[0]).not.toHaveProperty("whatsapp");
    expect(result.candidates[0]).not.toHaveProperty("socialLinks");
    expect(result.candidates[0]).not.toHaveProperty("bookingLinks");
    expect(result.candidates[0]).not.toHaveProperty("mapsUrl");
    expect(result.candidates[0]).not.toHaveProperty("latitude");
    expect(result.candidates[0]).not.toHaveProperty("longitude");
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

  it("maps Wikidata restaurant evidence with a public city and source, using a redirect-safe fixed-endpoint fetch", async () => {
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
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
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

  it("Discovery makes zero Workers AI calls (Task #6B boundary)", () => {
    // Discovery's candidate-collection and scoring code lives in
    // discovery-agent.ts and business-agents.ts; neither must import
    // ai-service.ts / WorkersAiService. Source-level regression guard,
    // since there is no runtime call log to assert against here.
    for (const file of ["discovery-agent.ts", "business-agents.ts"]) {
      const source = readFileSync(
        resolve(__dirname, file),
        "utf8"
      );
      expect(source).not.toContain("ai-service");
      expect(source).not.toContain("WorkersAiService");
    }
  });
});
