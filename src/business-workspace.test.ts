import { describe, expect, it } from "vitest";
import {
  BUSINESS_INTELLIGENCE_WORKSPACE_VERSION,
  buildBusinessWorkspace,
  businessMatchesSearch,
  canonicalBusinessSearchResult
} from "./business-workspace";
import type {
  BusinessWorkspaceProfile,
  DiscoveryCandidate,
  GastronomyObservation,
  Lead,
  QualificationResult,
  ReelScanLeadAudit
} from "./sales-types";

const candidate: DiscoveryCandidate = {
  id: "candidate-1",
  businessName: "Café Atlas",
  category: "cafe",
  city: "Marrakech",
  country: "MA",
  websiteUrl: "https://cafe-atlas.ma/",
  phone: "+212500000000",
  sourceUrls: ["https://directory.example/atlas"],
  socialLinks: ["https://instagram.com/cafe-atlas"],
  bookingLinks: [],
  languagesDetected: ["fr"],
  confidence: "High",
  priorityScore: 58,
  priorityReasons: ["Public website can be evaluated: +10"],
  learningAdjustment: 2,
  status: "approved",
  rejectionReason: null,
  discoveredAt: "2026-07-30T08:00:00.000Z",
  updatedAt: "2026-07-31T08:00:00.000Z",
  leadId: "lead-1",
  scannedAt: "2026-07-30T09:00:00.000Z",
  approvedAt: "2026-07-30T10:00:00.000Z",
  ignoredAt: null,
  decidedBy: "owner@example.com"
};

const lead: Lead = {
  id: "lead-1",
  businessName: "Café Atlas",
  category: "cafe",
  city: "Marrakech",
  country: "MA",
  websiteUrl: "https://cafe-atlas.ma/",
  publicEmail: "public@cafe-atlas.ma",
  phone: "+212500000000",
  sourceUrls: ["https://directory.example/atlas"],
  observedIssues: [],
  discoveredAt: "2026-07-30T08:00:00.000Z",
  score: 0,
  scoreReasons: [],
  status: "new",
  language: "fr",
  lastContactedAt: null,
  nextFollowUpAt: null,
  doNotContact: false,
  notes: "Public facts reviewed.",
  createdAt: "2026-07-30T08:00:00.000Z",
  updatedAt: "2026-07-31T08:00:00.000Z",
  pilot: false
};

const opportunity: GastronomyObservation = {
  code: "menu_missing",
  signal: "menu_accessibility",
  journeyStage: "guest_decision",
  detail: "No public menu link was detected.",
  evidence: "No menu reference in the checked links.",
  impact: "Guests cannot check the offer before deciding to visit.",
  suggestion: "Add a direct, mobile-readable menu link.",
  confidence: "High",
  kind: "opportunity",
  sourceUrl: "https://cafe-atlas.ma/",
  observedAt: "2026-07-31T08:00:00.000Z",
  verified: true,
  points: 10
};

function audit(
  id: string,
  createdAt: string,
  observations: GastronomyObservation[]
): ReelScanLeadAudit {
  return {
    id,
    leadId: lead.id,
    observations,
    framework: {
      guest_discovery: { label: "Guest discovery", evaluations: [] },
      guest_decision: {
        label: "Guest decision",
        evaluations: observations
      },
      guest_action: { label: "Guest action", evaluations: [] }
    },
    priorities: { critical: [], important: observations, optional: [] },
    recommendedService: "ReelFix",
    evidenceConfidence: observations.length ? "High" : "Low",
    verifiedOpportunityCount: observations.length,
    opportunityScore: observations.length ? 55 : null,
    qualityMetrics: {
      observationQuality: observations.length ? 5 : 0,
      businessRelevance: observations.length ? 5 : 0,
      personalization: observations.length ? 4 : 0,
      confidence: observations.length ? "High" : "Low",
      missingEvidence: observations.length ? 0 : 13
    },
    createdAt
  };
}

const qualification: QualificationResult = {
  id: "qualification-1",
  leadId: lead.id,
  score: 55,
  opportunityScore: 55,
  evidenceConfidence: "High",
  minimumEvidenceMet: true,
  criteria: {
    verifiedObservations: 3,
    highConfidenceObservations: 3,
    journeyStagesCovered: 2,
    opportunityStrength: 20
  },
  reasons: ["Minimum evidence met."],
  recommendedStatus: "qualified",
  createdAt: "2026-07-31T08:05:00.000Z"
};

function profileData(
  audits: ReelScanLeadAudit[] = [],
  qualifications: QualificationResult[] = []
) {
  return {
    lead,
    candidate,
    audits,
    qualifications,
    drafts: [],
    reviews: [],
    activities: [],
    followUps: [],
    contactEvents: []
  };
}

describe("Business Intelligence Workspace v1.0", () => {
  it("searches all required business identity fields", () => {
    const result = {
      id: candidate.id,
      leadId: lead.id,
      candidateId: candidate.id,
      businessName: candidate.businessName,
      category: candidate.category,
      city: candidate.city,
      country: candidate.country,
      websiteUrl: candidate.websiteUrl || null,
      status: candidate.status,
      discoveredAt: candidate.discoveredAt
    };
    expect(BUSINESS_INTELLIGENCE_WORKSPACE_VERSION).toBe("1.0");
    expect(businessMatchesSearch(result, "atlas")).toBe(true);
    expect(businessMatchesSearch(result, "marrakech")).toBe(true);
    expect(businessMatchesSearch(result, "cafe-atlas.ma")).toBe(true);
    expect(businessMatchesSearch(result, "approved")).toBe(true);
    expect(businessMatchesSearch(result, "casablanca")).toBe(false);
  });

  it("shows the canonical CRM identity and permanent do-not-contact status", () => {
    const blockedLead: Lead = {
      ...lead,
      businessName: "Canonical Café Atlas",
      status: "do_not_contact",
      doNotContact: true
    };
    const result = canonicalBusinessSearchResult(candidate, blockedLead);
    const profile = buildBusinessWorkspace({
      ...profileData(),
      lead: blockedLead
    });
    expect(result.businessName).toBe("Canonical Café Atlas");
    expect(result.status).toBe("do_not_contact");
    expect(profile.header.currentStatus).toBe("do_not_contact");
    expect(profile.crm.currentStage).toBe("do_not_contact");
  });

  it("builds insights only from verified evidence", () => {
    const profile = buildBusinessWorkspace(
      profileData(
        [audit("audit-1", "2026-07-31T08:00:00.000Z", [opportunity])],
        [qualification]
      )
    );
    expect(profile.overview.opportunityScore).toBe(55);
    expect(profile.insights.factsOnly).toBe(true);
    expect(profile.insights.biggestOpportunities).toEqual([opportunity.detail]);
    expect(profile.websiteGuardian.findings.ux).toEqual([opportunity]);
    expect(profile.websiteGuardian.findings.performance).toEqual([]);
    expect(profile.websiteGuardian.limitations).toContain(
      "Performance timing is not collected by the current ReelScan and is shown as not measured."
    );
  });

  it("compares verified issues between ReelScan reports", () => {
    const previous = audit("audit-previous", "2026-07-30T08:00:00.000Z", [
      opportunity
    ]);
    const current = audit("audit-current", "2026-07-31T08:00:00.000Z", []);
    const profile = buildBusinessWorkspace(profileData([current, previous]));
    expect(profile.reelScan.comparison.resolvedOpportunityCodes).toEqual([
      "menu_missing"
    ]);
    expect(profile.timeline.map((event) => event.label)).toContain(
      "ReelScan completed"
    );
  });

  it("does not manufacture a score or recommendation without evidence", () => {
    const profile: BusinessWorkspaceProfile =
      buildBusinessWorkspace(profileData());
    expect(profile.overview.opportunityScore).toBeNull();
    expect(profile.websiteGuardian.currentHealth).toBe("not_scanned");
    expect(profile.insights.biggestOpportunities).toEqual([]);
    expect(profile.insights.nextStep).toBe(
      "Run ReelScan and review the resulting evidence."
    );
    expect(profile.qualification.evidenceEditable).toBe(false);
  });
});
