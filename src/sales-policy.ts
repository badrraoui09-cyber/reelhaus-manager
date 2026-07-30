import type {
  Lead,
  LeadInput,
  LeadStatus,
  ObservedIssue
} from "./sales-types";

const ALLOWED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  discovered: ["qualified", "lost", "do_not_contact"],
  qualified: ["draft_ready", "lost", "do_not_contact"],
  draft_ready: ["approved", "lost", "do_not_contact"],
  approved: ["contacted", "draft_ready", "do_not_contact"],
  contacted: ["replied", "lost", "do_not_contact"],
  replied: ["meeting_requested", "proposal_sent", "lost", "do_not_contact"],
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

export function calculateLeadScore(input: {
  websiteUrl?: string;
  publicEmail?: string;
  category: string;
  city: string;
  issues: ObservedIssue[];
}): { score: number; reasons: string[] } {
  let score = 20;
  const reasons = ["20 Basispunkte: passender Hospitality-Betrieb"];
  if (input.websiteUrl) {
    score += 10;
    reasons.push("10 Punkte: öffentliche Website vorhanden");
  }
  if (input.publicEmail) {
    score += 10;
    reasons.push("10 Punkte: öffentliche geschäftliche E-Mail vorhanden");
  }
  const issuePoints = Math.min(
    50,
    input.issues.reduce((sum, issue) => sum + Math.max(0, issue.points), 0)
  );
  if (issuePoints) {
    score += issuePoints;
    reasons.push(`${issuePoints} Punkte: verifizierte Verbesserungsmöglichkeiten`);
  }
  if (!input.city.trim()) {
    score -= 20;
    reasons.push("-20 Punkte: Ort nicht verifiziert");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
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
