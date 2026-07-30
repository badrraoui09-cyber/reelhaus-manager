export const LEAD_CATEGORIES = [
  "restaurant",
  "cafe",
  "bakery",
  "riad",
  "small_hotel"
] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

export const LEAD_STATUSES = [
  "discovered",
  "qualified",
  "draft_ready",
  "approved",
  "contacted",
  "replied",
  "meeting_requested",
  "proposal_sent",
  "won",
  "lost",
  "do_not_contact"
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type OutreachLanguage = "fr" | "ar";

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
}

export interface Lead extends LeadInput {
  id: string;
  country: "MA";
  discoveredAt: string;
  score: number;
  scoreReasons: string[];
  status: LeadStatus;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  doNotContact: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface PublicWebsiteObservation {
  websiteUrl: string;
  sourceUrl: string;
  observedAt: string;
  title: string;
  language: string;
  mobileViewport: boolean;
  hasMenuLink: boolean;
  hasOpeningHours: boolean;
  imageCount: number;
  imagesMissingAlt: number;
  publicEmails: string[];
  phones: string[];
  whatsappLinks: string[];
  contactLinks: string[];
  mapsLinks: string[];
  issues: ObservedIssue[];
}
