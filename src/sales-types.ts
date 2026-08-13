export const LEAD_CATEGORIES = [
  "restaurant",
  "cafe",
  "bakery",
  "snack",
  "beach_club",
  "rooftop_restaurant",
  "riad",
  "small_hotel",
  "local_business"
] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

export const LEAD_STATUSES = [
  "new",
  "analyzing",
  "discovered",
  "qualified",
  "draft_ready",
  "approved",
  "contacted",
  "replied",
  "meeting",
  "meeting_requested",
  "proposal_sent",
  "won",
  "lost",
  "do_not_contact"
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type OutreachLanguage = "fr" | "ar";
export type RecommendedService = "ReelFix" | "ReelBuild" | "ReelCare";
export type EvidenceConfidence = "High" | "Medium" | "Low";
export const DISCOVERY_STATUSES = [
  "new",
  "queued",
  "analyzing",
  "scanned",
  "approved",
  "sent_to_reelscan",
  "rejected",
  "ignored",
  "qualified"
] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];
export type DiscoveryDecisionType = "approved" | "rejected" | "ignored";
export type GuestJourneyStage =
  | "guest_discovery"
  | "guest_decision"
  | "guest_action";
export type GastronomyObservationKind =
  | "opportunity"
  | "strength"
  | "coverage_gap";

export interface SourcedValue {
  value: string;
  sourceUrl: string;
  observedAt: string;
}

export interface ObservedIssue {
  code: string;
  detail: string;
  sourceUrl: string;
  observedAt: string;
  verified: boolean;
  points: number;
  signal?: string;
  journeyStage?: GuestJourneyStage;
  evidence?: string;
  impact?: string;
  confidence?: EvidenceConfidence;
  suggestion?: string;
  kind?: GastronomyObservationKind;
}

export interface GastronomyObservation extends ObservedIssue {
  signal: string;
  journeyStage: GuestJourneyStage;
  evidence: string;
  impact: string;
  confidence: EvidenceConfidence;
  suggestion: string;
  kind: GastronomyObservationKind;
}

export interface ReelHausQualityMetrics {
  observationQuality: number;
  businessRelevance: number;
  personalization: number;
  confidence: EvidenceConfidence;
  missingEvidence: number;
}

export interface LeadInput {
  businessName: string;
  category: LeadCategory;
  city: string;
  country?: "MA";
  websiteUrl?: string;
  mapsUrl?: string;
  publicEmail?: string;
  phone?: string;
  whatsapp?: string;
  sourceUrls: string[];
  observedIssues?: ObservedIssue[];
  recommendedService?: string;
  notes?: string;
  language?: OutreachLanguage;
  pilot?: boolean;
}

export interface DiscoveryCandidateInput {
  businessName: string;
  category: LeadCategory;
  city: string;
  country?: string;
  websiteUrl?: string;
  mapsUrl?: string;
  publicEmail?: string;
  phone?: string;
  whatsapp?: string;
  socialLinks?: string[];
  bookingLinks?: string[];
  languagesDetected?: string[];
  latitude?: number;
  longitude?: number;
  discoverySource?: string;
  sourceUrls: string[];
  language?: OutreachLanguage;
  pilot?: boolean;
  closed?: boolean;
}

export interface DiscoveryCandidate extends Omit<
  DiscoveryCandidateInput,
  "country" | "closed"
> {
  id: string;
  country: string;
  confidence: EvidenceConfidence;
  priorityScore: number;
  priorityReasons: string[];
  learningAdjustment: number;
  status: DiscoveryStatus;
  rejectionReason: string | null;
  discoveredAt: string;
  updatedAt: string;
  leadId: string | null;
  scannedAt: string | null;
  approvedAt: string | null;
  ignoredAt: string | null;
  decidedBy: string | null;
}

export interface DiscoveryDecisionRecord {
  id: string;
  candidateId: string;
  decision: DiscoveryDecisionType;
  actor: string;
  category: LeadCategory;
  city: string;
  country: string;
  priorityScore: number;
  decidedAt: string;
}

export interface Lead extends Omit<LeadInput, "observedIssues"> {
  id: string;
  country: "MA";
  observedIssues: ObservedIssue[];
  discoveredAt: string;
  score: number;
  scoreReasons: string[];
  status: LeadStatus;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  doNotContact: boolean;
  createdAt: string;
  updatedAt: string;
  pilot: boolean;
}

export interface LeadQualityReview {
  id: string;
  leadId: string;
  realOpportunity: boolean;
  observationAccuracy: number;
  emailPersonalization: number;
  scoreUsefulness: number;
  relevance: number;
  notes: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface Company {
  id: string;
  businessName: string;
  category: LeadCategory;
  city: string;
  country: "MA";
  websiteUrl: string | null;
  mapsUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReelScanLeadAudit {
  id: string;
  leadId: string;
  observations: GastronomyObservation[];
  framework: Record<
    GuestJourneyStage,
    {
      label: string;
      evaluations: GastronomyObservation[];
    }
  >;
  priorities: {
    critical: GastronomyObservation[];
    important: GastronomyObservation[];
    optional: GastronomyObservation[];
  };
  recommendedService: RecommendedService;
  evidenceConfidence: EvidenceConfidence;
  verifiedOpportunityCount: number;
  opportunityScore: number | null;
  qualityMetrics: ReelHausQualityMetrics;
  createdAt: string;
}

export interface QualificationResult {
  id: string;
  leadId: string;
  score: number;
  opportunityScore: number | null;
  evidenceConfidence: EvidenceConfidence;
  minimumEvidenceMet: boolean;
  criteria: {
    verifiedObservations: number;
    highConfidenceObservations: number;
    journeyStagesCovered: number;
    opportunityStrength: number;
  };
  reasons: string[];
  recommendedStatus: "qualified" | "new";
  createdAt: string;
}

export interface EmailDraft {
  id: string;
  leadId: string;
  language: OutreachLanguage;
  subject: string;
  body: string;
  kind: "initial" | "follow_up_1" | "follow_up_2";
  status: "draft_ready" | "approved" | "rejected" | "sent";
  version: number;
  providerDraftId: string | null;
  providerThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailReview {
  id: string;
  draftId: string;
  draftVersion: number;
  score: number;
  approved: boolean;
  personalization: number;
  issues: string[];
  rewrittenSubject: string;
  rewrittenBody: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  leadId: string | null;
  actor: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface BusinessFollowUp {
  id: string;
  leadId: string;
  draftId: string | null;
  sequence: number;
  status: string;
  scheduledFor: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface BusinessContactEvent {
  id: string;
  leadId: string;
  draftId: string | null;
  eventType: string;
  occurredAt: string;
  subject: string | null;
  approvedBy: string | null;
}

export interface BusinessSearchResult {
  id: string;
  leadId: string | null;
  candidateId: string | null;
  businessName: string;
  category: LeadCategory;
  city: string;
  country: string;
  websiteUrl: string | null;
  status: string;
  discoveredAt: string;
}

export interface BusinessWorkspaceTimelineEvent {
  id: string;
  type: string;
  label: string;
  actor: string;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface BusinessWorkspaceProfile {
  id: string;
  header: {
    leadId: string | null;
    candidateId: string | null;
    businessName: string;
    category: LeadCategory;
    city: string;
    country: string;
    websiteUrl: string | null;
    phone: string | null;
    publicEmail: string | null;
    socialLinks: string[];
    discoveredAt: string;
    currentStatus: string;
  };
  overview: {
    opportunityScore: number | null;
    confidence: EvidenceConfidence;
    currentRecommendation: string;
    lastActivity: BusinessWorkspaceTimelineEvent | null;
    assignedStatus: string;
    timelineSummary: string;
  };
  discovery: {
    sourceUrls: string[];
    priorityScore: number | null;
    priorityReasons: string[];
    duplicateStatus: "canonical" | "merged_duplicate" | "not_recorded";
    learningAdjustment: number;
    history: BusinessWorkspaceTimelineEvent[];
  };
  reelScan: {
    latest: ReelScanLeadAudit | null;
    history: ReelScanLeadAudit[];
    comparison: {
      previousScanAt: string | null;
      newOpportunityCodes: string[];
      resolvedOpportunityCodes: string[];
    };
  };
  websiteGuardian: {
    source: "reelscan_evidence";
    currentHealth: "not_scanned" | "evidence_available" | "needs_attention";
    latestReportAt: string | null;
    findings: Record<
      "seo" | "ux" | "accessibility" | "performance",
      GastronomyObservation[]
    >;
    trend: Array<{
      createdAt: string;
      verifiedOpportunities: number;
      confidence: EvidenceConfidence;
    }>;
    limitations: string[];
  };
  qualification: {
    latest: QualificationResult | null;
    history: QualificationResult[];
    missingEvidence: string[];
    evidenceEditable: false;
  };
  crm: {
    currentStage: string;
    notes: string;
    assignedOwner: string | null;
    followUps: BusinessFollowUp[];
    contactHistory: BusinessContactEvent[];
    statusTimeline: BusinessWorkspaceTimelineEvent[];
  };
  emailReview: {
    latestDraft: EmailDraft | null;
    latestReview: EmailReview | null;
  };
  timeline: BusinessWorkspaceTimelineEvent[];
  insights: {
    whyInteresting: string;
    biggestOpportunities: string[];
    nextStep: string;
    factsOnly: true;
  };
}

export interface BusinessAssistantOutput {
  type: "lead_summary" | "client_brief" | "proposal_outline" | "meeting_notes";
  title: string;
  sections: Array<{ heading: string; content: string }>;
  factsOnly: true;
  externalActionTaken: false;
}

export interface PublicWebsiteObservation {
  websiteUrl: string;
  sourceUrl: string;
  observedAt: string;
  title: string;
  language: string;
  mobileViewport: boolean;
  hasMenuLink: boolean;
  hasOpeningHours: boolean;
  hasFoodServiceInfo: boolean;
  hasTrustSignals: boolean;
  hasReservationLink: boolean;
  hasOrderingLink: boolean;
  imageCount: number;
  imagesMissingAlt: number;
  publicEmails: string[];
  phones: string[];
  whatsappLinks: string[];
  contactLinks: string[];
  mapsLinks: string[];
  issues: ObservedIssue[];
}
