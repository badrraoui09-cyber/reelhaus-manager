import type { Lead, LeadInput, LeadStatus } from "./sales-types";

export function outreachIsEnabled(value: string | undefined): boolean {
  return value === "true";
}

const ALLOWED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ["analyzing", "qualified", "lost", "do_not_contact"],
  analyzing: ["new", "qualified", "lost", "do_not_contact"],
  discovered: ["analyzing", "qualified", "lost", "do_not_contact"],
  qualified: ["draft_ready", "lost", "do_not_contact"],
  draft_ready: ["approved", "lost", "do_not_contact"],
  approved: ["contacted", "draft_ready", "do_not_contact"],
  contacted: ["replied", "lost", "do_not_contact"],
  replied: [
    "meeting",
    "meeting_requested",
    "proposal_sent",
    "lost",
    "do_not_contact"
  ],
  meeting: ["proposal_sent", "won", "lost", "do_not_contact"],
  meeting_requested: ["proposal_sent", "won", "lost", "do_not_contact"],
  proposal_sent: ["won", "lost", "do_not_contact"],
  won: ["do_not_contact"],
  lost: ["do_not_contact"],
  do_not_contact: []
};

export function normalizeUrl(value?: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeEmail(value?: string): string {
  return (value || "").trim().toLowerCase();
}

export function leadDedupeKey(input: LeadInput): string {
  const website = normalizeUrl(input.websiteUrl);
  if (website) return `website:${new URL(website).hostname.replace(/^www\./, "")}`;
  const email = normalizeEmail(input.publicEmail);
  if (email) return `email:${email}`;
  return `name-city:${input.businessName.trim().toLowerCase()}|${input.city
    .trim()
    .toLowerCase()}`;
}

// Task #6B: a hard, code-level gate for any Lead a discovery_candidates row
// still points at (discovery_candidates.lead_id) — independent of
// OUTREACH_ENABLED, so an accidental future flip of that env var back to
// "true" cannot re-enable outreach for a Discovery-origin lead. The caller
// (sales-agent.ts) is responsible for looking up whether the lead is
// Discovery-linked; this function is the single source of truth for what
// that lookup result means.
export function discoveryOutreachBlocked(isDiscoveryLinkedLead: boolean): boolean {
  return isDiscoveryLinkedLead;
}

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function canContact(lead: Pick<Lead, "doNotContact" | "status">): boolean {
  return !lead.doNotContact && lead.status !== "do_not_contact";
}

export function followUpAllowed(input: {
  lead: Pick<Lead, "doNotContact" | "status" | "lastContactedAt">;
  existingFollowUps: number;
  now: Date;
  minimumDays: number;
}): boolean {
  if (!canContact(input.lead) || input.lead.status !== "contacted") return false;
  if (input.existingFollowUps >= 2 || !input.lead.lastContactedAt) return false;
  const elapsed =
    input.now.getTime() - new Date(input.lead.lastContactedAt).getTime();
  return elapsed >= input.minimumDays * 86_400_000;
}

export function approvalIsUsable(input: {
  draftStatus: string;
  draftVersion: number;
  approvedVersion?: number;
  consumedAt?: string | null;
  contactAllowed: boolean;
}): boolean {
  return (
    input.draftStatus === "approved" &&
    input.approvedVersion === input.draftVersion &&
    !input.consumedAt &&
    input.contactAllowed
  );
}
