import { describe, expect, it } from "vitest";
import {
  calculateLeadScore,
  approvalIsUsable,
  canContact,
  canTransition,
  followUpAllowed,
  leadDedupeKey,
  outreachIsEnabled
} from "./sales-policy";
import type { LeadInput } from "./sales-types";

const leadInput: LeadInput = {
  businessName: "Café Atlas",
  category: "cafe",
  city: "Marrakech",
  country: "MA",
  websiteUrl: "https://www.example.ma/menu/",
  publicEmail: "contact@example.ma",
  sourceUrls: ["https://example.ma/contact"]
};

describe("lead policy", () => {
  it("keeps outreach disabled unless explicitly enabled", () => {
    expect(outreachIsEnabled(undefined)).toBe(false);
    expect(outreachIsEnabled("false")).toBe(false);
    expect(outreachIsEnabled("true")).toBe(true);
  });

  it("deduplicates by normalized website host", () => {
    expect(leadDedupeKey(leadInput)).toBe("website:example.ma");
    expect(
      leadDedupeKey({ ...leadInput, websiteUrl: "https://example.ma/" })
    ).toBe("website:example.ma");
  });

  it("uses transparent capped scoring", () => {
    const result = calculateLeadScore({
      websiteUrl: leadInput.websiteUrl,
      publicEmail: leadInput.publicEmail,
      category: leadInput.category,
      city: leadInput.city,
      issues: [
        {
          code: "mobile",
          detail: "Viewport missing",
          sourceUrl: "https://example.ma",
          observedAt: "2026-07-30T00:00:00.000Z",
          verified: true,
          points: 20
        }
      ]
    });
    expect(result.score).toBe(60);
    expect(result.reasons).toHaveLength(4);
  });

  it("enforces status and do-not-contact rules", () => {
    expect(canTransition("draft_ready", "approved")).toBe(true);
    expect(canTransition("contacted", "approved")).toBe(false);
    expect(canContact({ doNotContact: true, status: "qualified" })).toBe(false);
    expect(canContact({ doNotContact: false, status: "do_not_contact" })).toBe(false);
  });

  it("limits follow-ups by count and minimum interval", () => {
    const lead = {
      doNotContact: false,
      status: "contacted" as const,
      lastContactedAt: "2026-07-01T00:00:00.000Z"
    };
    expect(
      followUpAllowed({
        lead,
        existingFollowUps: 1,
        now: new Date("2026-07-10T00:00:00.000Z"),
        minimumDays: 7
      })
    ).toBe(true);
    expect(
      followUpAllowed({
        lead,
        existingFollowUps: 2,
        now: new Date("2026-07-20T00:00:00.000Z"),
        minimumDays: 7
      })
    ).toBe(false);
  });

  it("allows exactly one send per current approval", () => {
    const current = {
      draftStatus: "approved",
      draftVersion: 2,
      approvedVersion: 2,
      consumedAt: null,
      contactAllowed: true
    };
    expect(approvalIsUsable(current)).toBe(true);
    expect(approvalIsUsable({ ...current, consumedAt: "2026-07-30T10:00:00Z" })).toBe(
      false
    );
    expect(approvalIsUsable({ ...current, approvedVersion: 1 })).toBe(false);
    expect(approvalIsUsable({ ...current, contactAllowed: false })).toBe(false);
  });
});
